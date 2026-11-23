import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { connectorSchemas } from "../../brain/src/runtime/tools/connectors/connector-tools.ts";
import { discoverToolsForBotStep } from "../src/brain/service/connector-service/connector-service-dispatch.ts";
import type { ConnectorServiceOperations } from "../src/brain/service/connector-service.ts";

function catalog() {
  const versions = [{ id: "connector", revision: 1, catalog_version: 1 }];
  const discover = vi
    .fn()
    .mockReturnValueOnce({ items: [], versions, after: 10 })
    .mockReturnValue({ items: [], versions });
  const context = { deps: { connectors: { discover } } } as unknown as ConnectorServiceOperations;
  const request = {
    connectorId: "5a53e784-1aa4-4d34-8834-37f7f84d8c84",
    query: "items_search",
    limit: 5,
  };
  return {
    discover,
    page: (cursor?: string | null) =>
      discoverToolsForBotStep.call(
        context,
        "bot",
        connectorSchemas.connector_discover.parse(
          cursor === undefined ? request : { ...request, cursor },
        ),
      ),
    revise: () => {
      versions[0] = { id: "connector", revision: 2, catalog_version: 1 };
    },
  };
}

describe("connector discovery pagination", () => {
  it("rejects an invalid cursor before reading the catalog", () => {
    const { discover, page } = catalog();
    expect(() => page("0")).toThrow("connector_cursor_invalid");
    expect(discover).not.toHaveBeenCalled();
  });

  it.each([undefined, null])(
    "starts with cursor %s and accepts the returned next cursor",
    (cursor) => {
      const { discover, page } = catalog();
      const { nextCursor } = page(cursor);
      assert(nextCursor);
      expect(page(nextCursor).nextCursor).toBeNull();
      expect(discover).toHaveBeenLastCalledWith(
        "bot",
        undefined,
        expect.objectContaining({ after: 10 }),
      );
    },
  );

  it("reports a catalog change when a valid cursor's snapshot expires", () => {
    const { page, revise } = catalog();
    const { nextCursor } = page();
    assert(nextCursor);
    revise();
    expect(() => page(nextCursor)).toThrow("connector_catalog_changed");
  });
});
