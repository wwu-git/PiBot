// The phone's offline runtime streams models with the same pi-ai adapters as the desktop.
// Only modules whose import graph has no Node builtins are re-exported here, so the phone bundle
// (Metro / Hermes, react-native conditions) never reaches `node:*`, pi-coding-agent's session files
// or child processes. `node tools/dev/portable-graph.ts packages/agent/src/portable/index.ts` proves
// that graph; Metro needs the stand-ins in ./metro-shims.cjs for three pi-ai files.
// Deliberately not re-exported: `@earendil-works/pi-ai` root (its models/auth/telemetry pull in
// env-file and proxy helpers), `providers/*` catalogs (large and the phone receives one model from
// the desktop) and the OAuth helpers (subscription logins are not handed to phones).

import type {
  AssistantMessageEventStream,
  Context,
  Model,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { stream as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { withAnthropicThreadPolicy } from "../models/anthropic-threads.ts";

export type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";

/** APIs the desktop may hand to a phone: API-key providers and custom OpenAI-compatible ones. */
export const portableApis = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
] as const;
export type PortableApi = (typeof portableApis)[number];

export function isPortableApi(api: string): api is PortableApi {
  return (portableApis as readonly string[]).includes(api);
}

/**
 * One streamed model turn with the caller's key and `AbortSignal`. The SDKs use the global
 * `fetch`, which Expo SDK 58 replaces with its streaming fetch (React Native's own buffers the
 * whole body); `options.fetch` overrides it.
 */
export function streamPortable(
  model: Model<PortableApi>,
  context: Context,
  options: StreamOptions,
): AssistantMessageEventStream {
  const transcript = normalizeContext(context);
  switch (model.api) {
    case "anthropic-messages":
      return anthropicMessages(
        withAnthropicThreadPolicy(model as Model<"anthropic-messages">),
        transcript,
        options,
      );
    case "openai-completions":
      return openaiCompletions(model as Model<"openai-completions">, transcript, options);
    case "openai-responses":
      return openaiResponses(model as Model<"openai-responses">, transcript, options);
  }
}
