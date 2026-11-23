import { type Connector, RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import { expect, it, vi } from "vitest";
import { openConnectorConnection } from "../src/brain/service/connector-runtime.ts";
import { buildTargetStep } from "../src/brain/service/connector-service/connector-service-connection.ts";
import {
  diagnosticsStep,
  OUTSIDE_SANDBOX_ACK,
  setOutsideSandboxStep,
} from "../src/brain/service/connector-service/connector-service-sandbox.ts";
import type { ConnectorServiceOperations } from "../src/brain/service/connector-service.ts";

vi.mock("../src/brain/service/connector-runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/brain/service/connector-runtime.ts")>()),
  openConnectorConnection: vi.fn(),
}));

function fixture(reason: string) {
  const connector = {
    id: "connection",
    pluginInstallationId: "installation",
    revision: 3,
    enabled: false,
    outsideSandbox: false,
  };
  const server = { transport: "stdio", command: "synthetic", args: [], networkDomains: [] };
  const save = vi.fn();
  const confirmUnisolated = vi.fn(async () => ({ approved: true }));
  const prepareSet = vi
    .fn()
    .mockRejectedValueOnce(new RpcError(RpcErrorCodes.secretsUnavailable, reason))
    .mockResolvedValue(save);
  const setOutsideSandbox = vi.fn((_, __, commit: () => void) => {
    commit();
    return { ...connector, outsideSandbox: true };
  });
  const context = {
    deps: {
      connectors: { get: () => connector, configuration: () => server, setOutsideSandbox },
      plugins: { get: () => ({ sourceKind: "json" }) },
      platform: "darwin",
      actorBotId: "bot",
      secrets: { prepareSet },
      confirmUnisolated,
    },
    registry: { effectiveServer: () => server },
    startFailures: new Map(),
    emitConnectorChanged: vi.fn(),
  } as unknown as ConnectorServiceOperations;
  const toggle = (signal?: AbortSignal) =>
    setOutsideSandboxStep.call(
      context,
      { id: connector.id, expectedRevision: connector.revision, enabled: true },
      signal,
    );
  return { toggle, confirmUnisolated, prepareSet, setOutsideSandbox, save };
}

it.each(["secure_storage_busy", "secure_storage_timeout"])(
  "saves the approved receipt after %s, without showing a second confirmation",
  async (reason) => {
    const { toggle, confirmUnisolated, prepareSet, setOutsideSandbox, save } = fixture(reason);
    const result = await toggle();
    expect(result.connector.outsideSandbox).toBe(true);
    expect(confirmUnisolated).toHaveBeenCalledTimes(1);
    expect(prepareSet).toHaveBeenCalledTimes(2);
    expect(prepareSet).toHaveBeenLastCalledWith(
      "connector:connection",
      OUTSIDE_SANDBOX_ACK,
      expect.stringContaining('"approvedRevision":3'),
    );
    expect(prepareSet.mock.calls[1]).toEqual(prepareSet.mock.calls[0]);
    expect(setOutsideSandbox).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  },
);

it("leaves the sandbox unchanged when system storage refuses access", async () => {
  const { toggle, prepareSet, setOutsideSandbox, save } = fixture("secrets_unavailable");
  await expect(toggle()).rejects.toThrow("secrets_unavailable");
  expect(prepareSet).toHaveBeenCalledTimes(1);
  expect(setOutsideSandbox).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("leaves the sandbox unchanged when the request is cancelled while waiting", async () => {
  const { toggle, prepareSet, setOutsideSandbox, save } = fixture("secure_storage_busy");
  const cancel = new AbortController();
  const result = expect(toggle(cancel.signal)).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(prepareSet).toHaveBeenCalledTimes(1));
  cancel.abort();
  await result;
  expect(prepareSet).toHaveBeenCalledTimes(1);
  expect(setOutsideSandbox).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

function receiptFixture(getReceipt: () => Promise<string | undefined>) {
  const connector = {
    id: "connection",
    pluginInstallationId: "installation",
    outsideSandbox: true,
  };
  const server = { transport: "stdio", command: "synthetic", args: [], networkDomains: [] };
  const context = {
    deps: {
      connectors: { get: () => connector, configuration: () => server },
      plugins: { get: () => ({ sourceKind: "json" }), isApplication: () => false },
      platform: "darwin",
      secrets: { get: getReceipt },
    },
    registry: { effectiveServer: () => server, fromInstallation: () => undefined },
    generations: new Map(),
    startFailures: new Map(),
  } as unknown as ConnectorServiceOperations;
  return {
    diagnose: () => diagnosticsStep.call(context, { id: connector.id }),
    start: () =>
      buildTargetStep.call(context, connector as Connector).open(new AbortController().signal),
  };
}

it("keeps sandbox controls available when secure storage cannot read the receipt", async () => {
  const { diagnose } = receiptFixture(async () => {
    throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
  });
  await expect(diagnose()).resolves.toMatchObject({
    outsideSandbox: "available",
    needsReconfirm: false,
    receiptUnavailable: true,
  });
});

it("asks for confirmation when the stored receipt is missing", async () => {
  const { diagnose } = receiptFixture(async () => undefined);
  await expect(diagnose()).resolves.toMatchObject({
    outsideSandbox: "available",
    needsReconfirm: true,
  });
  expect(await diagnose()).not.toMatchObject({ receiptUnavailable: true });
});

it("propagates receipt errors unrelated to secure storage", async () => {
  const error = new Error("unexpected store failure");
  const { diagnose } = receiptFixture(async () => {
    throw error;
  });
  await expect(diagnose()).rejects.toBe(error);
});

it("reports unavailable secure storage before starting the MCP process", async () => {
  const { start } = receiptFixture(async () => {
    throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
  });
  await expect(start()).rejects.toMatchObject({ failureCode: "secure_storage_unavailable" });
  expect(openConnectorConnection).not.toHaveBeenCalled();
});
