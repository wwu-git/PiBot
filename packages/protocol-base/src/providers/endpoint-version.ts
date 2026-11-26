export function explicitProviderEndpointVersion(pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, "");
  const last = path.slice(path.lastIndexOf("/") + 1);
  return /^v\d+(?:[a-z]+\d*)?$/i.test(last) ? last : undefined;
}

/** The Anthropic SDK appends /v1/messages internally and cannot use other versions. */
export function supportsProviderEndpointVersion(api: string, version: string | undefined) {
  return api !== "anthropic-messages" || version === undefined || version === "v1";
}
