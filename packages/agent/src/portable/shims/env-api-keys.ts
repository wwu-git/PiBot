// Phone build stand-in for pi-ai 1.6.0 `dist/env-api-keys.js`. The original discovers keys from
// process.env and probes files through `import(variable)`, which Metro refuses to bundle; a phone
// has no environment keys or credential files, so only the names the adapters import remain.
// Keep the names in step with the locked pi-ai version (Metro fails loudly on a missing export).
export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const ANTHROPIC_OAUTH_TOKEN_ENV = "ANTHROPIC_OAUTH_TOKEN";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
export const ANTHROPIC_FEDERATION_RULE_ID_ENV = "ANTHROPIC_FEDERATION_RULE_ID";
export const ANTHROPIC_ORGANIZATION_ID_ENV = "ANTHROPIC_ORGANIZATION_ID";
export const ANTHROPIC_SERVICE_ACCOUNT_ID_ENV = "ANTHROPIC_SERVICE_ACCOUNT_ID";
export const ANTHROPIC_IDENTITY_TOKEN_FILE_ENV = "ANTHROPIC_IDENTITY_TOKEN_FILE";
export const ANTHROPIC_WORKSPACE_ID_ENV = "ANTHROPIC_WORKSPACE_ID";

export function findEnvKeys(): string[] | undefined {
  return undefined;
}

export function getEnvApiKey(): string | undefined {
  return undefined;
}
