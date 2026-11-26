import { describe, expect, it } from "vitest";
import { validateConnectorArgs } from "./connector-schema.ts";

describe("connector argument schemas", () => {
  it.each([
    ["uint16", 65_535],
    ["uint32", 4_294_967_295],
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

  it("validates nullable UUID fields in a tagged action", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            action: { const: "httpRequest" },
            itemId: { type: ["string", "null"], format: "uuid" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { action: { const: "selectProject" } },
          required: ["action"],
          additionalProperties: false,
        },
      ],
    };
    const uuid = "01234567-89ab-cdef-0123-456789abcdef";
    const check = (itemId: unknown) =>
      validateConnectorArgs(schema, { action: "httpRequest", itemId });
    for (const value of [null, uuid, uuid.toUpperCase()]) {
      expect(() => check(value)).not.toThrow();
    }
    for (const value of [1, "not-a-uuid", uuid.replaceAll("-", ""), `${uuid}\n`]) {
      expect(() => check(value)).toThrow("connector_args_invalid");
    }
  });

  it("validates a referenced schema with annotation siblings", () => {
    const schema = {
      $defs: { ResponseFormat: { enum: ["legacy", "structured"] } },
      properties: {
        responseFormat: {
          $ref: "#/$defs/ResponseFormat",
          description: "Response format",
          "x-label": "format",
        },
      },
    };
    expect(() => validateConnectorArgs(schema, { responseFormat: "structured" })).not.toThrow();
    expect(() => validateConnectorArgs(schema, { responseFormat: "unknown" })).toThrow(
      "connector_args_invalid",
    );
    for (const sibling of [
      { const: "structured" },
      { $schema: "https://example.invalid/schema" },
    ]) {
      const rejected = {
        ...schema,
        properties: {
          responseFormat: { ...schema.properties.responseFormat, ...sibling },
        },
      };
      expect(() => validateConnectorArgs(rejected, {})).toThrow("connector_schema_unsupported");
    }
  });

  it("refuses unknown formats and external, missing, or cyclic references", () => {
    for (const schema of [
      { properties: { value: { type: "integer", format: "unknown" } } },
      { properties: { value: { type: "integer", format: "uuid" } } },
      { properties: { value: { type: ["integer", "string"], format: "uuid" } } },
      { properties: { value: { $ref: "https://example.invalid/schema" } } },
      { properties: { value: { $ref: "#/$defs/Missing" } } },
      { $defs: { Cycle: { $ref: "#/$defs/Cycle" } } },
    ]) {
      expect(() => validateConnectorArgs(schema, {})).toThrow("connector_schema_unsupported");
    }
  });
});
