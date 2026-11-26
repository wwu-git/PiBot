import {
  explicitProviderEndpointVersion,
  supportsProviderEndpointVersion,
} from "@pibot/protocol-base";
import type { CustomProviderConfig } from "../core/types.ts";

export function customProviderEndpoints({
  baseUrl,
  api,
}: Pick<CustomProviderConfig, "baseUrl" | "api">) {
  const base = new URL(baseUrl);
  const path = base.pathname.replace(/\/+$/, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  const explicit = explicitProviderEndpointVersion(path);
  // Vertex puts its version before the project path; appending /v1 changes the endpoint.
  const openaiPath =
    api === "openai-completions" &&
    (last.toLowerCase() === "openapi" ||
      path.split("/").some((part) => /^v\d+(?:[a-z]+\d*)?$/i.test(part)));
  const version = explicit ?? (api === "google-generative-ai" ? "v1beta" : "v1");
  const versionedPath = explicit || openaiPath ? path : `${path}/${version}`;
  const modelsUrl = new URL(base);
  modelsUrl.pathname = `${versionedPath}/models`;
  // Anthropic's client owns the fixed /v1/messages suffix. Other clients need the version here.
  // Preserve unsupported explicit versions rather than silently sending credentials to v1.
  const supported = supportsProviderEndpointVersion(api, version);
  base.pathname =
    api === "anthropic-messages" && supported ? versionedPath.slice(0, -3) || "/" : versionedPath;
  return { sdkBaseUrl: base.href, modelsUrl, supported };
}
