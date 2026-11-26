// Deliberately bounded JSON Schema subset. Unknown assertion keywords must not
// silently disappear before approval; unsupported schemas are never dispatched.
export class ConnectorSchemaError extends Error {
  constructor(readonly code: "connector_schema_unsupported" | "connector_args_invalid") {
    super(code);
  }
}
type Schema = boolean | Record<string, unknown>;
const annotations = new Set(["title", "description", "default", "examples", "$comment", "$schema"]);
const keywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
]);
const unsignedFormats = new Map([
  ["uint16", 65_535],
  ["uint32", 4_294_967_295],
  ["uint64", Number.MAX_SAFE_INTEGER],
  ["uint", Number.MAX_SAFE_INTEGER],
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
function unsupported(): never {
  throw new ConnectorSchemaError("connector_schema_unsupported");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateConnectorArgs(schema: unknown, args: Record<string, unknown>): void {
  const definitions = object(schema) && object(schema.$defs) ? schema.$defs : {};
  function resolveRef(ref: unknown): unknown {
    if (typeof ref !== "string" || !/^#\/\$defs\/[A-Za-z0-9_-]+$/u.test(ref)) unsupported();
    const name = ref.slice("#/$defs/".length);
    if (!Object.hasOwn(definitions, name)) unsupported();
    return definitions[name];
  }
  let nodes = 0;
  function check(value: unknown, depth = 0): asserts value is Schema {
    if (++nodes > 2000 || depth > 24) unsupported();
    if (typeof value === "boolean") return;
    if (!object(value)) unsupported();
    for (const [key, entry] of Object.entries(value)) {
      // Vendor extensions (`x-…`, e.g. GitHub's `x-mcp-header`) are annotations by convention and
      // never constrain a value; rejecting them refused every call to GitHub's search tools and
      // broke the owner's routine connection trigger (2026-11-01).
      if (key.startsWith("x-")) continue;
      if (annotations.has(key)) {
        if (
          key === "$schema" &&
          ![
            "http://json-schema.org/draft-07/schema#",
            "https://json-schema.org/draft/2020-12/schema",
          ].includes(String(entry))
        )
          unsupported();
        continue;
      }
      if (key === "$defs") {
        if (depth !== 0 || !object(entry)) unsupported();
        for (const child of Object.values(entry)) check(child, depth + 1);
        continue;
      }
      if (key === "$ref") {
        if (
          Object.keys(value).some(
            (name) => name !== "$ref" && !annotations.has(name) && !name.startsWith("x-"),
          )
        )
          unsupported();
        check(resolveRef(entry), depth + 1);
        continue;
      }
      if (key === "format") {
        const kinds = Array.isArray(value.type) ? value.type : [value.type];
        if (typeof entry !== "string") unsupported();
        const formattedType =
          entry === "uuid" ? "string" : unsignedFormats.has(entry) ? "integer" : null;
        if (
          formattedType === null ||
          !kinds.includes(formattedType) ||
          kinds.some((kind) => kind !== formattedType && kind !== "null")
        )
          unsupported();
        continue;
      }
      if (!keywords.has(key)) unsupported();
      if (key === "type") {
        const list = Array.isArray(entry) ? entry : [entry];
        if (!list.length || list.some((kind) => typeof kind !== "string" || !types.has(kind)))
          unsupported();
      } else if (key === "properties") {
        if (!object(entry)) unsupported();
        for (const child of Object.values(entry)) check(child, depth + 1);
      } else if (["items", "additionalProperties", "not"].includes(key)) check(entry, depth + 1);
      else if (["allOf", "anyOf", "oneOf"].includes(key)) {
        if (!Array.isArray(entry) || !entry.length || entry.length > 100) unsupported();
        for (const child of entry) check(child, depth + 1);
      } else if (key === "required") {
        if (!Array.isArray(entry) || entry.some((name) => typeof name !== "string")) unsupported();
      } else if (key === "enum") {
        if (!Array.isArray(entry) || !entry.length) unsupported();
      } else if (key !== "const") {
        if (typeof entry !== "number" || !Number.isFinite(entry)) unsupported();
        if (
          (key.startsWith("min") || key.startsWith("max")) &&
          !["minimum", "maximum"].includes(key) &&
          (!Number.isSafeInteger(entry) || entry < 0)
        )
          unsupported();
      }
    }
  }
  check(schema);
  let steps = 0;
  function equal(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b))
      return a.length === b.length && a.every((entry, index) => equal(entry, b[index]));
    if (object(a) && object(b)) {
      const keys = Object.keys(a);
      return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
      );
    }
    return false;
  }
  function matches(s: Schema, value: unknown, depth = 0): boolean {
    if (++steps > 20_000 || depth > 40) throw new ConnectorSchemaError("connector_args_invalid");
    if (typeof s === "boolean") return s;
    if (s.$ref !== undefined) return matches(resolveRef(s.$ref) as Schema, value, depth + 1);
    const isType = (type: string) => {
      if (type === "null") return value === null;
      if (type === "object") return object(value);
      if (type === "array") return Array.isArray(value);
      if (type === "integer") return typeof value === "number" && Number.isInteger(value);
      return typeof value === type;
    };
    if (
      s.type !== undefined &&
      !(Array.isArray(s.type) ? s.type : [s.type]).some((t) => isType(String(t)))
    )
      return false;
    if (s.enum && !(s.enum as unknown[]).some((entry) => equal(entry, value))) return false;
    if (Object.hasOwn(s, "const") && !equal(s.const, value)) return false;
    const test = (child: Schema) => matches(child, value, depth + 1);
    if (s.allOf && !(s.allOf as Schema[]).every(test)) return false;
    if (s.anyOf && !(s.anyOf as Schema[]).some(test)) return false;
    if (s.oneOf && (s.oneOf as Schema[]).filter(test).length !== 1) return false;
    if (s.not !== undefined && test(s.not as Schema)) return false;
    if (typeof value === "string") {
      if (s.format === "uuid" && (value.length !== 36 || !uuid.test(value))) return false;
      const length = [...value].length;
      if (s.minLength !== undefined && length < Number(s.minLength)) return false;
      if (s.maxLength !== undefined && length > Number(s.maxLength)) return false;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      const unsignedMax = typeof s.format === "string" ? unsignedFormats.get(s.format) : undefined;
      if (unsignedMax !== undefined && (value < 0 || value > unsignedMax)) return false;
      if (s.minimum !== undefined && value < Number(s.minimum)) return false;
      if (s.maximum !== undefined && value > Number(s.maximum)) return false;
      if (s.exclusiveMinimum !== undefined && value <= Number(s.exclusiveMinimum)) return false;
      if (s.exclusiveMaximum !== undefined && value >= Number(s.exclusiveMaximum)) return false;
    }
    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < Number(s.minItems)) return false;
      if (s.maxItems !== undefined && value.length > Number(s.maxItems)) return false;
      if (s.items !== undefined && !value.every((v) => matches(s.items as Schema, v, depth + 1)))
        return false;
    }
    if (object(value)) {
      const keys = Object.keys(value);
      if (s.minProperties !== undefined && keys.length < Number(s.minProperties)) return false;
      if (s.maxProperties !== undefined && keys.length > Number(s.maxProperties)) return false;
      if (s.required && !(s.required as string[]).every((key) => Object.hasOwn(value, key)))
        return false;
      const properties = (s.properties ?? {}) as Record<string, Schema>;
      for (const key of keys) {
        const child = Object.hasOwn(properties, key) ? properties[key] : s.additionalProperties;
        if (child !== undefined && !matches(child as Schema, value[key], depth + 1)) return false;
      }
    }
    return true;
  }
  if (!matches(schema, args)) throw new ConnectorSchemaError("connector_args_invalid");
}
