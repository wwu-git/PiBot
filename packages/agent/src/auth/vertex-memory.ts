import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantImages,
  AssistantMessage,
  ImageApi,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  Model,
  Provider,
  SimpleStreamOptions,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { getCurrentTools, getInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import type { GenerateContentConfig, GoogleGenAI } from "@google/genai";
import { AgentError, agentHttpStatus, mapAgentError } from "../core/errors.ts";
import type { AgentAuthPorts } from "../core/types.ts";
import { checkedImage } from "../images/image-response.ts";
import { markFetchOnly } from "../network/network.ts";
import { createGoogleTokenSource, type GoogleTokenSource } from "./google-token.ts";

type AuthClient = NonNullable<
  NonNullable<
    NonNullable<ConstructorParameters<typeof GoogleGenAI>[0]>["googleAuthOptions"]
  >["authClient"]
>;

// Public SDK adapters receive credentials in memory; ADC discovery and key files are never used.
// Pi Bot mints the access token itself (google-token.ts) and gives the SDK a client that only
// returns that header, so google-auth-library never opens its own unproxied connection. The
// SDK's model requests use the global fetch, which the brain routes through the manual proxy.
// The Google SDK (with google-auth-library and gaxios, ~60 modules) and pi's Google helpers
// load on the first Vertex request, not with the brain: most users never pick Vertex.
export function memoryVertex(
  provider: Provider,
  ports: AgentAuthPorts,
  tokens: GoogleTokenSource = createGoogleTokenSource(),
  createClient: (
    options: ConstructorParameters<typeof GoogleGenAI>[0],
  ) => Pick<GoogleGenAI, "models"> | Promise<Pick<GoogleGenAI, "models">> = async (options) =>
    new (await import("@google/genai")).GoogleGenAI(options),
): Provider {
  const vertexClient = async (signal: AbortSignal) => {
    const material = await ports.cloud(provider.id, signal);
    if (!material?.googleCredentials) throw new AgentError("auth_failed");
    const project = material.env.GOOGLE_CLOUD_PROJECT;
    const location = material.env.GOOGLE_CLOUD_LOCATION;
    if (!project || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(project) || !location)
      throw new AgentError("auth_failed");
    let baseUrl: string;
    if (location === "global") baseUrl = "https://aiplatform.googleapis.com/";
    else if (location === "us" || location === "eu")
      baseUrl = `https://aiplatform.${location}.rep.googleapis.com/`;
    else if (/^[a-z]+(?:-[a-z]+)+[1-9]\d*$/.test(location))
      baseUrl = `https://${location}-aiplatform.googleapis.com/`;
    else throw new AgentError("auth_failed");
    const token = await tokens.token(material.googleCredentials, signal);
    const authClient = {
      getRequestHeaders: async () => new Headers({ authorization: `Bearer ${token}` }),
    } as unknown as AuthClient;
    const client = await createClient({
      vertexai: true,
      project,
      location,
      httpOptions: { baseUrl, retryOptions: { attempts: 1 } },
      googleAuthOptions: {
        authClient,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    });
    return { client };
  };
  const stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const events = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    void (async () => {
      const signal = AbortSignal.any([
        options?.signal ?? new AbortController().signal,
        AbortSignal.timeout(120_000),
      ]);
      try {
        const material = await ports.cloud(provider.id, signal);
        if (!material?.googleCredentials) throw new Error("Cloud credentials unavailable");
        const project = material.env.GOOGLE_CLOUD_PROJECT;
        const location = material.env.GOOGLE_CLOUD_LOCATION;
        if (!project || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(project) || !location)
          throw new Error("Invalid Vertex project or location");
        let baseUrl: string;
        if (location === "global") baseUrl = "https://aiplatform.googleapis.com/";
        else if (location === "us" || location === "eu")
          baseUrl = `https://aiplatform.${location}.rep.googleapis.com/`;
        else if (/^[a-z]+(?:-[a-z]+)+[1-9]\d*$/.test(location))
          baseUrl = `https://${location}-aiplatform.googleapis.com/`;
        else throw new Error("Invalid Vertex location");
        const token = await tokens.token(material.googleCredentials, signal);
        const {
          convertMessages,
          convertTools,
          mapStopReason,
          resolveGoogleFunctionCallingMode,
          resolveGoogleThinkingLevel,
          supportsGoogleStrictToolSampling,
          toGoogleSdkThinkingLevel,
          toGoogleThinkingLevel,
          usesGoogleThinkingLevel,
        } = await import("@earendil-works/pi-ai/api/google-shared");
        signal.throwIfAborted();
        // GoogleAuth returns a supplied authClient as-is: no ADC lookup, metadata probe or refresh.
        const authClient = {
          getRequestHeaders: async () => new Headers({ authorization: `Bearer ${token}` }),
        } as unknown as AuthClient;
        // Explicit SDK options outrank inherited endpoint overrides and contain no user URL.
        const client = await createClient({
          vertexai: true,
          project,
          location,
          httpOptions: { baseUrl, retryOptions: { attempts: 1 } },
          googleAuthOptions: {
            authClient,
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          },
        });
        const system = getInitialSystemMessage(context.messages);
        const tools = getCurrentTools(context.messages);
        const strict = supportsGoogleStrictToolSampling(model.id);
        const toolMode = resolveGoogleFunctionCallingMode(tools, options?.toolChoice, strict);
        const config: GenerateContentConfig = {
          abortSignal: signal,
          automaticContinuation: false,
          maxOutputTokens: options?.maxTokens ?? model.maxTokens,
          temperature: options?.temperature,
          systemInstruction: system ? getSystemMessageText(system) : undefined,
          tools: convertTools(tools, false, strict),
          ...(toolMode ? { toolConfig: { functionCallingConfig: { mode: toolMode } } } : {}),
        };
        if (model.reasoning && options?.reasoning) {
          const level = resolveGoogleThinkingLevel(
            model as Model<"google-vertex">,
            options.reasoning,
          );
          config.thinkingConfig = usesGoogleThinkingLevel(model as Model<"google-vertex">)
            ? {
                includeThoughts: true,
                thinkingLevel: toGoogleSdkThinkingLevel(toGoogleThinkingLevel(level)),
              }
            : {
                includeThoughts: true,
                thinkingBudget: { minimal: 0, low: 1024, medium: 8192, high: 24576 }[level],
              };
        }
        const params = {
          model: model.id,
          contents: convertMessages(model as Model<"google-vertex">, context),
          config,
        };
        const override = await options?.onPayload?.(params, model);
        const chunks = await client.models.generateContentStream(
          (override ?? params) as typeof params,
        );
        events.push({ type: "start", partial: message });
        for await (const chunk of chunks) {
          signal.throwIfAborted();
          const candidate = chunk.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            const index = message.content.length;
            if (part.text !== undefined) {
              // Keep provider part signatures on their original blocks for transcript replay.
              if (part.thought) {
                message.content.push({
                  type: "thinking",
                  thinking: part.text,
                  thinkingSignature: part.thoughtSignature,
                });
                events.push({ type: "thinking_start", contentIndex: index, partial: message });
                events.push({
                  type: "thinking_delta",
                  contentIndex: index,
                  delta: part.text,
                  partial: message,
                });
                events.push({
                  type: "thinking_end",
                  contentIndex: index,
                  content: part.text,
                  partial: message,
                });
              } else {
                message.content.push({
                  type: "text",
                  text: part.text,
                  textSignature: part.thoughtSignature,
                });
                events.push({ type: "text_start", contentIndex: index, partial: message });
                events.push({
                  type: "text_delta",
                  contentIndex: index,
                  delta: part.text,
                  partial: message,
                });
                events.push({
                  type: "text_end",
                  contentIndex: index,
                  content: part.text,
                  partial: message,
                });
              }
            } else if (part.functionCall?.name) {
              const call: ToolCall = {
                type: "toolCall",
                id: part.functionCall.id ?? randomUUID(),
                name: part.functionCall.name,
                arguments: JSON.parse(JSON.stringify(part.functionCall.args ?? {})),
                thoughtSignature: part.thoughtSignature,
              };
              message.content.push(call);
              events.push({ type: "toolcall_start", contentIndex: index, partial: message });
              events.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: JSON.stringify(call.arguments),
                partial: message,
              });
              events.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: call,
                partial: message,
              });
            }
          }
          if (candidate?.finishReason) {
            message.rawStopReason = candidate.finishReason;
            message.stopReason = mapStopReason(candidate.finishReason);
          }
          if (chunk.usageMetadata) {
            const u = chunk.usageMetadata;
            message.usage.input = (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0);
            message.usage.output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
            message.usage.cacheRead = u.cachedContentTokenCount ?? 0;
            message.usage.totalTokens = u.totalTokenCount ?? 0;
            calculateCost(model, message.usage);
          }
        }
        if (message.stopReason === "stop" && message.content.some((b) => b.type === "toolCall"))
          message.stopReason = "toolUse";
        if (!["stop", "length", "toolUse"].includes(message.stopReason))
          throw new Error("Provider ended without completion");
        events.push({
          type: "done",
          reason: message.stopReason as "stop" | "length" | "toolUse",
          message,
        });
      } catch (error) {
        message.stopReason = signal.aborted ? "aborted" : "error";
        // SDK errors can carry response bodies: keep a phrase mapAgentError classifies plus status.
        const code = error instanceof AgentError ? error.code : mapAgentError(error);
        const status = agentHttpStatus(error);
        const text =
          code === "auth_failed"
            ? "Vertex authentication failed"
            : code === "network"
              ? "Vertex network error"
              : "Vertex request failed";
        message.errorMessage =
          message.rawStopReason === "MALFORMED_FUNCTION_CALL"
            ? "malformed_function_call"
            : status
              ? `${text} (${status})`
              : text;
        events.push({ type: "error", reason: message.stopReason, error: message });
      } finally {
        events.end();
      }
    })();
    return events;
  };
  const generateImages = async (
    model: ImageModel<ImageApi>,
    context: ImagesContext,
    options?: ImagesOptions,
  ): Promise<AssistantImages> => {
    const timestamp = Date.now();
    try {
      const signal = AbortSignal.any([
        options?.signal ?? new AbortController().signal,
        AbortSignal.timeout(300_000),
      ]);
      signal.throwIfAborted();
      const prompt = context.input
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      const images = context.input.filter((part) => part.type === "image");
      if (!prompt.trim() || images.length > 3) throw new AgentError("provider_error");
      const { client } = await vertexClient(signal);
      const response = await client.models.generateContent({
        model: model.id,
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              ...images.map((image) => ({
                inlineData: { data: image.data, mimeType: image.mimeType },
              })),
            ],
          },
        ],
        config: {
          abortSignal: signal,
          automaticContinuation: false,
          responseModalities: ["IMAGE", "TEXT"],
          candidateCount: 1,
        } as GenerateContentConfig,
      });
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const output = parts.flatMap((part) => [
        ...(part.text ? [{ type: "text" as const, text: part.text }] : []),
        ...(part.inlineData && typeof part.inlineData.data === "string"
          ? [checkedImage(part.inlineData.data, part.inlineData.mimeType ?? "image/png")]
          : []),
      ]);
      if (!output.some((part) => part.type === "image")) throw new AgentError("provider_error");
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp,
        stopReason: "stop",
        output,
      };
    } catch (error) {
      const code = options?.signal?.aborted ? "aborted" : mapAgentError(error);
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp,
        output: [],
        stopReason: code === "aborted" ? "aborted" : "error",
        errorMessage: code,
      };
    }
  };
  return markFetchOnly({
    ...provider,
    stream: stream as Provider["stream"],
    streamSimple: stream,
    generateImages,
  });
}
