// Phone build stand-in for pi-ai 1.6.0 `dist/auth/context.js`: same browser behaviour (no env
// values, no files) without the `import(variable)` that Metro refuses to bundle. The phone always
// passes its key explicitly, so pi-ai never needs to discover one.
export function defaultProviderAuthContext() {
  return {
    async env(_name: string): Promise<string | undefined> {
      return undefined;
    },
    async fileExists(_path: string): Promise<boolean> {
      return false;
    },
  };
}
