import type { Bot, ConnectorAccess, Group } from "@pibot/plugins-contract/full";
import { type Peer, useT, useWorkspace } from "@pibot/renderer-kit";
import { useCallback } from "react";
import { useConnectorPage } from "../shell/remote.ts";
import { ConnectorFeedback, ConnectorPagination } from "./ConnectorFeedback.tsx";
import { type AccessTarget, accessIsOn, flipAccess } from "./connections/access-grant.ts";
import { WhoCanUse } from "./connections/WhoCanUse.tsx";

type ResolveAccess = (peer: Peer, signal: AbortSignal) => Promise<ConnectorAccess>;
const PAGE_SIZE = 50;
const MAX_TARGETS = 500;

// A page of avatars is not the entire grant. Snapshot live Bots before changing "all" to selected.
async function flipEveryone(
  peer: Peer,
  signal: AbortSignal,
  access: ConnectorAccess,
  target: AccessTarget,
) {
  const ids = new Set<string>();
  let before: string | undefined;
  for (let offset = 0; offset <= MAX_TARGETS; offset += PAGE_SIZE) {
    const page: Bot[] = await peer.call("bots.list", { before, limit: PAGE_SIZE }, { signal });
    for (const bot of page) if (!bot.archivedAt) ids.add(bot.id);
    if (page.length < PAGE_SIZE) {
      if (target.kind === "bot" && !ids.has(target.id)) break;
      const next = flipAccess(access, [...ids], target);
      if (next.bots.length <= MAX_TARGETS) return next;
      break;
    }
    const cursor = page.at(-1)?.id;
    if (!cursor || cursor === before) break;
    before = cursor;
  }
  throw new Error("connector_access_target_limit");
}

function withSelected<T extends { id: string }>(page: T[], known: T[], selected: string[]) {
  const rows = new Map(page.map((row) => [row.id, row]));
  const ids = new Set(selected);
  for (const row of known) if (ids.has(row.id) && !rows.has(row.id)) rows.set(row.id, row);
  return { rows: [...rows.values()], missing: selected.filter((id) => !rows.has(id)) };
}

export function ConnectorAccessEditor({
  access,
  disabled,
  save,
  resolveAndSave,
  requestedTarget,
}: {
  access: ConnectorAccess;
  disabled: boolean;
  save(access: ConnectorAccess): void;
  requestedTarget?: AccessTarget;
  resolveAndSave?(resolve: ResolveAccess): void;
}) {
  const t = useT();
  const workspace = useWorkspace();
  const loadBots = useCallback(async (peer: Peer, signal: AbortSignal, cursor?: string) => {
    const items = await peer.call("bots.list", { before: cursor, limit: PAGE_SIZE }, { signal });
    return { items, nextCursor: items.length === PAGE_SIZE ? (items.at(-1)?.id ?? null) : null };
  }, []);
  const loadGroups = useCallback(async (peer: Peer, signal: AbortSignal, cursor?: string) => {
    const items = await peer.call("groups.list", { before: cursor, limit: PAGE_SIZE }, { signal });
    return { items, nextCursor: items.length === PAGE_SIZE ? (items.at(-1)?.id ?? null) : null };
  }, []);
  const bots = useConnectorPage<Bot>(loadBots, 0);
  const groups = useConnectorPage<Group>(loadGroups, 0);
  const selected = access.mode === "selected";
  const visibleSelected = (kind: AccessTarget["kind"], ids: string[]) =>
    requestedTarget?.kind === kind ? [...new Set([requestedTarget.id, ...ids])] : ids;
  const botRows = withSelected(
    bots.value?.items ?? [],
    workspace.bots,
    visibleSelected("bot", selected ? access.bots : []),
  );
  const groupRows = withSelected(
    groups.value?.items ?? [],
    workspace.groups,
    visibleSelected("group", selected ? access.groups : []),
  );
  const unavailable = [
    ...botRows.missing.map((id) => ({
      kind: "bot" as const,
      id,
      name: t("connectors.unknownBot", { id }),
    })),
    ...groupRows.missing.map((id) => ({
      kind: "group" as const,
      id,
      name: t("connectors.unknownGroup", { id }),
    })),
  ];
  return (
    <WhoCanUse
      bots={botRows.rows}
      groups={groupRows.rows}
      unavailable={unavailable}
      requestedTarget={requestedTarget}
      disabled={disabled}
      all={
        resolveAndSave
          ? {
              on: access.mode === "all",
              disabled,
              toggle: (on) => save({ mode: on ? "all" : "selected", bots: [], groups: [] }),
            }
          : undefined
      }
      isDisabled={(kind, id) =>
        (kind === "bot" ? bots.loading : groups.loading) ||
        (selected &&
          !accessIsOn(access, { kind, id }) &&
          (kind === "bot" ? access.bots : access.groups).length >= MAX_TARGETS)
      }
      isOn={(kind, id) => accessIsOn(access, { kind, id })}
      toggle={(kind, id) => {
        const target = { kind, id };
        if (selected) save(flipAccess(access, [], target));
        else resolveAndSave?.((peer, signal) => flipEveryone(peer, signal, access, target));
      }}
    >
      <ConnectorFeedback loading={bots.loading} error={bots.error} retry={bots.refresh} />
      <ConnectorFeedback loading={groups.loading} error={groups.error} retry={groups.refresh} />
      <ConnectorPagination
        previous={bots.previous}
        next={bots.next}
        disabled={bots.loading || disabled}
      />
      <ConnectorPagination
        previous={groups.previous}
        next={groups.next}
        disabled={groups.loading || disabled}
      />
    </WhoCanUse>
  );
}
