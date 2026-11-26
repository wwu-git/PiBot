// Read the built APK so the update feed cannot advertise an unbuilt app-config version.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function androidFeed(apk, version, url, aapt = "aapt") {
  const result = spawnSync(aapt, ["dump", "badging", apk], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      "Cannot inspect the APK. Set AAPT to Android SDK Build Tools' aapt executable.",
      {
        cause: result.error,
      },
    );
  }
  const metadata =
    /^package: name='space\.pibot\.mobile' versionCode='([0-9]+)' versionName='([^']+)'/mu.exec(
      result.stdout,
    );
  const versionCode = Number(metadata?.[1]);
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || metadata?.[2] !== version) {
    throw new Error(`Expected a space.pibot.mobile APK for ${version} with a valid versionCode`);
  }

  const hash = createHash("sha256");
  let size = 0;
  const signal = AbortSignal.timeout(10 * 60_000);
  for await (const chunk of createReadStream(apk, { signal })) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { version, versionCode, url, sha256: hash.digest("hex"), size };
}
