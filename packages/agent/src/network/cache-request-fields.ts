// Project actual HTTP model payloads onto known cache field names without retaining values.
const names = new Set([
  "cache_control",
  "cached_content",
  "cachedContent",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "thread",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cacheRequestFields(body: unknown): string[] | undefined {
  if (typeof body !== "string" || body.length > 16 * 1024 * 1024) return;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    // Requests using a non-JSON encoding cannot supply this diagnostic.
    return;
  }
  if (
    !isRecord(payload) ||
    ![payload.messages, payload.input, payload.contents].some(Array.isArray)
  )
    return;
  const fields = new Set<string>();
  const pending: unknown[] = [payload];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (names.has(key)) fields.add(key);
        // Tool schemas and arguments can themselves declare these names.
        if (
          [
            "input_schema",
            "parameters",
            "input",
            "args",
            "arguments",
            "schema",
            "json_schema",
          ].includes(key) &&
          !(value === payload && key === "input")
        )
          continue;
        if (child && typeof child === "object") pending.push(child);
      }
    }
  }
  return [...fields].sort();
}
