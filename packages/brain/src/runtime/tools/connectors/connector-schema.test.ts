import { describe, expect, it } from "vitest";
import { validateConnectorArgs } from "./connector-schema.ts";

describe("connector argument schemas", () => {
  it.each([
    ["uint16", 65_535],
    ["uint64", Number.MAX_SAFE_INTEGER],
    ["uint", Number.MAX_SAFE_INTEGER],
  ])("validates nullable %s values without losing integer bounds", (format, max) => {
    const schema = { type: ["integer", "null"], format };
    const check = (value: unknown) =>
      validateConnectorArgs({ properties: { value: schema } }, { value });
    expect(() => check(null)).not.toThrow();
    expect(() => check(max)).not.toThrow();
    for (const value of [-1, 0.5, max + 1, "1"]) {
      expect(() => check(value)).toThrow("connector_args_invalid");
    }
  });

  it("validates array items against a root schema definition", () => {
    const schema = {
      $defs: {
        File: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      properties: { files: { type: "array", items: { $ref: "#/$defs/File" } } },
    };
    expect(() => validateConnectorArgs(schema, { files: [{ path: "fixture" }] })).not.toThrow();
    expect(() => validateConnectorArgs(schema, { files: [{}] })).toThrow("connector_args_invalid");
  });

  it("refuses unknown formats and external, missing, or cyclic references", () => {
    for (const schema of [
      { properties: { value: { type: "integer", format: "unknown" } } },
      { properties: { value: { $ref: "https://example.invalid/schema" } } },
      { properties: { value: { $ref: "#/$defs/Missing" } } },
      { $defs: { Cycle: { $ref: "#/$defs/Cycle" } } },
    ]) {
      expect(() => validateConnectorArgs(schema, {})).toThrow("connector_schema_unsupported");
    }
  });
});
