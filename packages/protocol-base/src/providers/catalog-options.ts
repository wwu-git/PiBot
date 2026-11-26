// Shares Pi Bot provider identities and routing defaults across packages.
export const MAGPIE_PROVIDER = {
  id: "magpie",
  name: "Magpie",
  defaultPort: 3425,
  attribution: "magpie-pibot",
} as const;

export function magpieBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

/** Stored preset endpoints must use the literal IPv4 loopback and canonical version path. */
export function magpiePort(baseUrl: string): number | undefined {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/v1$/.exec(baseUrl);
  const port = Number(match?.[1]);
  return port <= 65535 && magpieBaseUrl(port) === baseUrl ? port : undefined;
}

/**
 * The ChatGPT plan (official Sign in with ChatGPT) is its own provider,
 * listed under 订阅 beside OpenAI's API-key provider, so a Bot picks either and both work at once.
 * The id is pi's name for that official sign-in; it is not one of pi's builtin provider ids, and
 * pi's legacy `openai-codex` (Codex CLI client id) stays retired.
 */
export const CHATGPT_PLAN_PROVIDER = "openai-chatgpt";
/**
 * Maintainers 2026-11-15: OpenAI refused the owner's account for the official
 * route (subscription_sharing_user_not_eligible) although it works on the web, so the plan can also
 * sign in through pi's legacy Codex login (Codex CLI client id, chatgpt.com Codex backend). Its own
 * id, so the official sign-in, old retired `openai-codex` choices and this one never share
 * credentials or selections.
 */
export const CHATGPT_CODEX_PROVIDER = "chatgpt-codex";
export const CHATGPT_PLAN_PROVIDERS: readonly string[] = [
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_CODEX_PROVIDER,
];
/** Either ChatGPT plan sign-in: OAuth only, never an API key, never sent to a phone. */
export function isChatGPTPlanProvider(id: string): boolean {
  return CHATGPT_PLAN_PROVIDERS.includes(id);
}

// Region choices select existing provider identities; they never copy credentials between accounts.
export const providerFamilies = [
  {
    name: "Moonshot AI",
    variants: [
      ["moonshotai", "global"],
      ["moonshotai-cn", "china"],
    ],
  },
  {
    name: "MiniMax",
    variants: [
      ["minimax", "global"],
      ["minimax-cn", "china"],
    ],
  },
  {
    name: "Z.ai GLM Coding Plan",
    variants: [
      ["zai", "global"],
      ["zai-coding-cn", "china"],
    ],
  },
  {
    name: "Qwen Coding Plan",
    variants: [
      ["qwen-token-plan", "global"],
      ["qwen-token-plan-cn", "china"],
      ["qwen-token-plan-individual", "individual"],
      ["qwen-token-plan-individual-cn", "individualChina"],
    ],
  },
  {
    name: "Xiaomi Token Plan",
    variants: [
      ["xiaomi-token-plan-ams", "europe"],
      ["xiaomi-token-plan-sgp", "singapore"],
      ["xiaomi-token-plan-cn", "china"],
    ],
  },
] as const;

export function providerFamily(id: string) {
  return providerFamilies.find((family) => family.variants.some(([value]) => value === id));
}

export function providerPlan(id: string): { name: string; alternative?: string } | undefined {
  if (id === "zai" || id === "zai-coding-cn")
    return { name: "Z.ai GLM Coding Plan", alternative: "Z.ai API" };
  if (providerFamily(id)?.name === "Qwen Coding Plan")
    return { name: "Qwen Coding Plan", alternative: "Qwen API" };
  if (["xiaomi-token-plan-ams", "xiaomi-token-plan-sgp", "xiaomi-token-plan-cn"].includes(id))
    return { name: "Xiaomi Token Plan" };
  if (id === "kimi-coding") return { name: "Kimi For Coding" };
  return undefined;
}
