import type { OAuthAuth, Provider } from "@earendil-works/pi-ai";
import {
  CHATGPT_CODEX_PROVIDER,
  CHATGPT_PLAN_PROVIDER,
} from "@pibot/protocol-base/provider-catalog";
import type { AgentAuthPorts } from "../core/types.ts";
import { chatGPTSubscriptionAccess } from "./chatgpt-access.ts";
import { trackedChatGPTAuth } from "./chatgpt-auth.ts";
import { chatGPTOAuth } from "./chatgpt-login.ts";
import { chatGPTPlanProvider } from "./chatgpt-requests.ts";
import { oauthRefreshError } from "./oauth-refresh.ts";

const OFFICIAL_BASE_URL = "https://api.openai.com/v1";

function open(providerId: string, ports: AgentAuthPorts | undefined): ports is AgentAuthPorts {
  return providerId === CHATGPT_PLAN_PROVIDER && !!ports && chatGPTSubscriptionAccess.available;
}

/**
 * The ChatGPT plan provider's sign-in. With the release gate closed there is none, so no sign-in
 * or refresh can start and the plan provider is not registered at all.
 */
export function chatGPTSignIn(
  providerId: string,
  ports: AgentAuthPorts | undefined,
): { oauth: OAuthAuth; settled(): Promise<void> } | undefined {
  if (!open(providerId, ports)) return undefined;
  const tracked = trackedChatGPTAuth(
    chatGPTOAuth({ saved: () => ports.read(CHATGPT_PLAN_PROVIDER) }),
  );
  return {
    oauth: {
      ...tracked.auth,
      async refresh(credential, signal) {
        try {
          return await tracked.auth.refresh(credential, signal);
        } catch (error) {
          // Only fixed codes leave agent; token endpoint failures may describe the credential.
          const failure = oauthRefreshError(error, signal);
          if (failure.code === "auth_failed") ports.reauth(CHATGPT_PLAN_PROVIDER);
          throw failure;
        }
      },
    },
    settled: tracked.settled,
  };
}

/**
 * The plan through pi's legacy Codex login (maintainers 2026-11-15): pi's own `openai-codex` OAuth,
 * which signs in as the Codex CLI (its fixed client id, localhost:1455 callback). pi asks "browser
 * or device code" first; Pi Bot's sign-in is the browser one, so that question is answered here
 * instead of reaching a login screen that only takes a pasted redirect URL.
 */
export function chatGPTCodexSignIn(
  codexOAuth: OAuthAuth | undefined,
  ports: AgentAuthPorts | undefined,
): { oauth: OAuthAuth; settled(): Promise<void> } | undefined {
  if (!codexOAuth || !open(CHATGPT_PLAN_PROVIDER, ports)) return undefined;
  const tracked = trackedChatGPTAuth({
    ...codexOAuth,
    name: "ChatGPT (Codex)",
    login: (interaction, options) =>
      codexOAuth.login(
        {
          ...interaction,
          prompt: async (input) =>
            input.type === "select" && input.options.some((option) => option.id === "browser")
              ? "browser"
              : interaction.prompt(input),
        },
        options,
      ),
  });
  return {
    oauth: {
      ...tracked.auth,
      async refresh(credential, signal) {
        try {
          return await tracked.auth.refresh(credential, signal);
        } catch (error) {
          const failure = oauthRefreshError(error, signal);
          if (failure.code === "auth_failed") ports.reauth(CHATGPT_CODEX_PROVIDER);
          throw failure;
        }
      },
    },
    settled: tracked.settled,
  };
}

/**
 * The ChatGPT plan is its own provider beside OpenAI's API key, so a Bot
 * picks one or the other and both work at once. The plan's token is refused by the OpenAI API
 * (api.openai.com answered 403 on the owner's real account), so plan models use pi's ChatGPT
 * backend route exactly as pi defines it: the `openai-codex` catalog and its
 * `openai-codex-responses` API (chatgpt.com/backend-api/codex, bearer token plus the
 * `chatgpt-account-id` header read from the token). Only pi's legacy sign-in (Codex CLI client id)
 * is replaced by Pi Bot's official one, and the id changes so credentials resolve to this
 * provider (pi resolves them by `model.provider`). The OpenAI provider stays API-key only.
 */
export function chatGPTPlanFromCodex(
  codex: Provider,
  oauth: OAuthAuth,
  ports: AgentAuthPorts,
  responses?: Provider,
  /** The legacy Codex sign-in uses the Codex backend under its own provider id. */
  identity: { id: string; name: string } = { id: CHATGPT_PLAN_PROVIDER, name: "ChatGPT" },
): Provider {
  // OpenAI's open-source Sign in with ChatGPT route (developers.openai.com/siwc, 2026-11-15): the
  // plan token is a Bearer for POST https://api.openai.com/v1/responses (store false, stream true;
  // pi's Responses route sends both). chatgpt.com's Codex backend wants Codex CLI tokens carrying a
  // chatgpt_account_id claim, which the official token does not have, so every request failed
  // locally ("Failed to extract accountId from token", shown as provider_error).
  const official = !!responses;
  // pi drops the fields a ChatGPT sign-in refuses only when model.provider is exactly "openai";
  // ours is the plan's own id, so pi sent prompt_cache_retention and every request got
  // 400 "Unsupported parameter: prompt_cache_retention" (owner, r6, 2026-11-15). The same
  // omissions as pi's isChatGPTSignIn, stated as compat: no cache retention/options, no
  // max_output_tokens, no configuration_update items. Pi Bot never sends temperature for chat.
  const signInCompat = {
    supportsLongCacheRetention: false,
    supportsExplicitPromptCacheMode: false,
    supportsMaxOutputTokens: false,
    supportsMidConvoEffort: false,
  };
  const own = <T extends { provider: string; api?: unknown; baseUrl?: unknown; compat?: unknown }>(
    model: T,
  ): T => ({
    ...model,
    provider: identity.id,
    ...(official
      ? {
          api: "openai-responses",
          baseUrl: OFFICIAL_BASE_URL,
          compat: { ...(model.compat as object | undefined), ...signInCompat },
        }
      : {
          // Keep high/xhigh in reasoning.effort while pi #12361 affects mid-conversation updates.
          compat: { ...(model.compat as object | undefined), supportsMidConvoEffort: false },
        }),
  });
  const all = codex.getAllModels?.bind(codex) ?? codex.getModels.bind(codex);
  const chat = codex.getModels.bind(codex);
  const route = responses ?? codex;
  return chatGPTPlanProvider(
    {
      ...route,
      id: identity.id,
      name: identity.name,
      auth: { oauth },
      refreshModels: undefined,
      filterAllModels: undefined,
      filterModels: undefined,
      getModels: () => chat().map(own),
      getAllModels: () => all().map(own),
    },
    (limited) => ports.usageLimit?.(identity.id, limited),
    (route) => ports.planRequest?.(route),
    (failure) => ports.planRequest?.(failure),
  );
}
