import { expect, it, vi } from "vitest";
import {
  ConnectorService,
  type ConnectorServiceDeps,
} from "../src/brain/service/connector-service.ts";

it("restarts enabled connections after a keyring failure on the next brain startup", async () => {
  const keyringFailure = {
    enabled: true,
    kind: "mcp_stdio",
    outsideSandbox: true,
    status: "error",
    statusDetailCode: "secure_storage_unavailable",
    revision: 4,
  };
  const items = [
    { ...keyringFailure, id: "recover" },
    { ...keyringFailure, id: "disabled", enabled: false },
    { ...keyringFailure, id: "unrelated", statusDetailCode: "connection_failed" },
    { ...keyringFailure, id: "inside-sandbox", outsideSandbox: false },
    { ...keyringFailure, id: "remote", kind: "mcp_remote" },
    { ...keyringFailure, id: "ready", status: "ready", statusDetailCode: null },
    { ...keyringFailure, id: "idle", status: "idle", statusDetailCode: null },
  ];
  const request = vi.fn(() => ({ connectorId: null }));
  const service = new ConnectorService({
    actorBotId: "test-bot",
    pluginDefinitions: [],
    connectors: { list: () => ({ items, nextCursor: null }) },
    operations: {
      reconcileFailedUninstalls: () => ({ items: [], nextCursor: null }),
      pending: () => ({ items: [], nextCursor: null }),
      request,
    },
  } as unknown as ConnectorServiceDeps);

  service.recoverPending();
  await service.chain;

  expect(request.mock.calls).toEqual(
    ["recover", "ready", "idle"].map((id) => [
      { id, expectedRevision: 4, kind: "restart" },
      "test-bot",
    ]),
  );
});
