// Read legacy Windows credentials with the host’s PowerShell.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { windowsSystemRoot } from "../core/windows-environment.ts";
import { legacyWindowsTarget } from "./legacy-format.ts";

/**
 * just-secrets 0.0.2 stored Windows credentials under `secrets:<hex>` targets. Never open those with
 * @napi-rs/keyring's withTarget: on Windows that read replaced the stored credential with an empty
 * one (round-1 VM 2026-11-12: a runner upgrade erased its identity seed). They are only read and
 * deleted here, through CredReadW / CredDeleteW in a PowerShell child with no stdin.
 */
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class PiBotLegacyCredential { [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct C { public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; } [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred); [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredDeleteW(string target, uint type, uint flags); [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p); public static string Read(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return "missing"; throw new Exception("read " + e); } try { C c = (C)Marshal.PtrToStructure(p, typeof(C)); if (c.CredentialBlobSize > 2560) throw new Exception("size"); byte[] b = new byte[c.CredentialBlobSize]; if (b.Length != 0) Marshal.Copy(c.CredentialBlob, b, 0, b.Length); string s = Convert.ToBase64String(b); Array.Clear(b, 0, b.Length); return "value:" + s; } finally { CredFree(p); } } public static string Delete(string t) { if (CredDeleteW(t, 1, 0)) return "deleted"; int e = Marshal.GetLastWin32Error(); if (e == 1168) return "missing"; throw new Exception("delete " + e); } }\'',
  "$t = $env:PIBOT_LEGACY_TARGET",
  "if ($t -notmatch '^secrets:[0-9a-f]{8,1100}$') { exit 3 }",
  "if ($env:PIBOT_LEGACY_OPERATION -eq 'delete') { [Console]::Out.Write([PiBotLegacyCredential]::Delete($t)) } else { [Console]::Out.Write([PiBotLegacyCredential]::Read($t)) }",
].join("\n");

function powershell(
  operation: "read" | "delete",
  service: string,
  name: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const root = windowsSystemRoot(process.env);
  const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        shell: false,
        windowsHide: true,
        // No stdin: PowerShell started with an inherited open stdin can wait for it forever.
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          SystemRoot: root,
          PIBOT_LEGACY_TARGET: legacyWindowsTarget(service, name),
          PIBOT_LEGACY_OPERATION: operation,
        },
      },
    );
    let out = "",
      failed = false;
    const stop = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(stop, 15_000);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 8192) stop();
    });
    child.stderr.on("data", () => {});
    child.once("error", (error) => {
      cleanup();
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "legacy_credentials_unavailable"
            : "legacy_credentials_failed",
        ),
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (signal.aborted) return reject(signal.reason);
      if (failed || code !== 0) return reject(new Error("legacy_credentials_failed"));
      resolve(out.trim());
    });
  });
}

/** The old value, or null when there is no old credential. Caller verifies identity before use. */
export async function readLegacyWindows(service: string, name: string, signal: AbortSignal) {
  const result = await powershell("read", service, name, signal);
  if (result === "missing") return null;
  if (!result.startsWith("value:")) throw new Error("legacy_credentials_failed");
  const bytes = Buffer.from(result.slice(6), "base64");
  // Runner builds before c5b916ee0 opened these targets with keyring withTarget, which replaced the
  // credential with an empty one. An empty value can never be an identity, and returning "" made a
  // fresh runner in the same folder fail with identity_corrupt on every start (v0.0.2 Windows VM).
  if (bytes.length === 0) return null;
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes) || bytes.length > 2560)
      throw new Error("legacy_credentials_failed");
    return text;
  } finally {
    bytes.fill(0);
  }
}

/** Delete the old credential too, or a later lookup could resurrect a deleted native entry. */
export async function deleteLegacyWindows(service: string, name: string, signal: AbortSignal) {
  const result = await powershell("delete", service, name, signal);
  if (result !== "deleted" && result !== "missing") throw new Error("legacy_credentials_failed");
}
