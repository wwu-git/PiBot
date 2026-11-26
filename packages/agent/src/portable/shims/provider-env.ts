// Phone build stand-in for pi-ai 1.6.0 `dist/utils/provider-env.js`: the original's only extra is
// a Bun-sandbox fallback that `require("node:fs")`s /proc/self/environ, which Metro would try to
// resolve. Scoped values first, then whatever process.env the engine has (none on Hermes).
export function getProviderEnvValue(
  name: string,
  env?: Record<string, string>,
): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return env?.[name] || proc?.env?.[name] || undefined;
}
