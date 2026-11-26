import type { ChatPeer, GroupSessionCache } from "@pibot/client-core";
import {
  type Bot,
  type Group,
  type GroupTask,
  type MethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";
import { GroupRunState } from "./conversation/run-state.ts";
import { subscribeGroupData } from "./data-events.ts";
import { readGroupBots, readGroupRuns, readGroupTasks } from "./data-reads.ts";

export type PublicRun = MethodResults["chat.runs"][number];
export interface GroupSnapshot {
  group?: Group;
  bots: Bot[];
  tasks: GroupTask[];
  runs: PublicRun[];
  cycle?: MethodResults["groups.state"];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  partialRuns: boolean;
  paging: boolean;
  identityReady: boolean;
  membersReady: boolean;
  detailsLoading: boolean;
  detailsError: boolean;
  runsLoading: boolean;
}
export type ReadKind = "group" | "members" | "tasks" | "runs" | "cycle";

/** Critical identity and independently reconciled details cannot gate recent chat history. */
export class GroupData {
  private state: GroupSnapshot;
  private listeners = new Set<() => void>();
  private off: (() => void)[] = [];
  private lifetime = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private notification?: ReturnType<typeof setTimeout>;
  private active = false;
  private generation = 0;
  private jobs = new Map<ReadKind, Promise<void>>();
  private pending = new Set<ReadKind>();
  private failures = new Set<ReadKind>();
  private revisions = { group: 0, members: 0, tasks: 0, runs: 0, cycle: 0 };
  private runState = new GroupRunState();
  /**
   * Run states are complete once a read finished in this lifetime. Later re-reads after a
   * pause or a finished run keep the loaded list quietly; showing 「后台运行状态仍在恢复」 for
   * each of them made a routine refresh minutes after start look like startup recovery.
   */
  private runsSettled = false;
  constructor(
    readonly peer: ChatPeer,
    readonly groupId: string,
    private readonly cache?: GroupSessionCache,
  ) {
    const preview = cache?.readGroup(peer, groupId);
    this.state = {
      group: preview?.group,
      bots: preview?.bots ?? [],
      tasks: [],
      runs: [],
      loading: !preview,
      error: false,
      hasMore: false,
      partialRuns: true,
      paging: false,
      identityReady: false,
      membersReady: false,
      detailsLoading: true,
      detailsError: false,
      runsLoading: true,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<GroupSnapshot>, defer = false) {
    if (!this.active) return;
    // Every read returns fresh objects even when nothing changed. Memoized message rows take
    // group and bots, so keep the old reference for equal content or each run re-renders all rows.
    for (const key of ["group", "bots"] as const)
      if (
        key in patch &&
        patch[key] !== this.state[key] &&
        JSON.stringify(patch[key]) === JSON.stringify(this.state[key])
      )
        patch = { ...patch, [key]: this.state[key] };
    if (
      Object.entries(patch).every(([key, value]) =>
        Object.is(this.state[key as keyof GroupSnapshot], value),
      )
    )
      return;
    this.state = { ...this.state, ...patch };
    if (defer) {
      this.notification ??= setTimeout(() => {
        this.notification = undefined;
        this.notify();
      }, 100);
      return;
    }
    clearTimeout(this.notification);
    this.notification = undefined;
    this.notify();
  }
  private notify() {
    if (!this.active) return;
    for (const listener of this.listeners) listener();
  }
  private schedule() {
    if (!this.active || !this.pending.size) return;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      for (const kind of [...this.pending]) {
        if (this.jobs.has(kind)) continue;
        this.pending.delete(kind);
        void this.read(kind);
      }
    }, 250);
  }
  /**
   * `identity`: the group itself may have changed (created, deleted, members). Routine changes —
   * every run start/finish, pause, a permission or Bot edit — keep showing what is loaded and
   * refresh quietly: dropping readiness on each of them disabled the composer and showed
   * "正在确认…" / "较早运行记录未全部载入" for the whole time a member was running (owner
   * 2026-11-05). The brain still validates every action against the current group.
   */
  private changed(kind: ReadKind, identity = false) {
    this.revisions[kind]++;
    this.pending.add(kind);
    if (kind === "group" && identity) this.publish({ identityReady: false, membersReady: false });
    if (kind === "members" && identity) this.publish({ membersReady: false });
    this.schedule();
  }
  start() {
    this.generation++;
    this.active = true;
    this.jobs.clear();
    this.pending.clear();
    this.failures.clear();
    this.runState.clear();
    this.runsSettled = false;
    this.lifetime = new AbortController();
    this.state = {
      ...this.state,
      paging: false,
      identityReady: false,
      membersReady: false,
      partialRuns: true,
    };
    this.off = subscribeGroupData(
      this.peer,
      this.groupId,
      {
        getSnapshot: this.getSnapshot,
        publish: (patch, defer) => this.publish(patch, defer),
        changed: (kind, identity) => this.changed(kind, identity),
      },
      this.runState,
    );
    void this.refresh();
    return () => {
      this.active = false;
      this.generation++;
      this.lifetime.abort();
      clearTimeout(this.timer);
      clearTimeout(this.notification);
      this.timer = undefined;
      this.notification = undefined;
      for (const unsubscribe of this.off) unsubscribe();
      this.off = [];
      this.pending.clear();
    };
  }
  private read(kind: ReadKind): Promise<void> {
    if (!this.active) return Promise.resolve();
    const existing = this.jobs.get(kind);
    if (existing) {
      this.pending.add(kind);
      return existing;
    }
    if (kind !== "group" && !this.state.identityReady) return Promise.resolve();
    if (kind === "tasks" && this.state.paging) {
      this.pending.add(kind);
      return Promise.resolve();
    }
    const generation = this.generation;
    const job = this.readInside(kind).finally(() => {
      if (generation !== this.generation) return;
      this.jobs.delete(kind);
      this.publish({
        detailsLoading: [...this.jobs.keys()].some((key) => key !== "group"),
        runsLoading: this.jobs.has("runs") && !this.runsSettled,
      });
      this.schedule();
    });
    this.jobs.set(kind, job);
    this.publish({
      detailsLoading: true,
      ...(kind === "runs" && !this.runsSettled ? { runsLoading: true } : {}),
    });
    return job;
  }
  private async readInside(kind: ReadKind) {
    const generation = this.generation,
      revision = this.revisions[kind],
      groupRevision = this.revisions.group;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
    const current = () => this.active && generation === this.generation && !signal.aborted;
    const group = this.state.group;
    const cacheVersion = this.cache?.version;
    try {
      let patch: Partial<GroupSnapshot>;
      if (kind === "group") {
        const value = await waitRpc(
          () => this.peer.call("groups.get", { groupId: this.groupId }, { signal }),
          signal,
        );
        signal.throwIfAborted();
        if (value.id !== this.groupId) throw new Error("Wrong group identity");
        if (!current() || revision !== this.revisions.group) return;
        const bots = this.state.bots.filter((bot) =>
          value.members.some((member) => member.botId === bot.id),
        );
        this.publish({
          group: value,
          bots,
          loading: false,
          error: false,
          identityReady: true,
          ...(group?.conversationId && group.conversationId !== value.conversationId
            ? { tasks: [], runs: [], cycle: undefined, hasMore: false, partialRuns: true }
            : {}),
        });
        if (group?.conversationId && group.conversationId !== value.conversationId)
          this.runsSettled = false;
        if (cacheVersion !== undefined)
          this.cache?.writeGroup(this.peer, value, bots, cacheVersion);
        for (const next of ["members", "tasks", "runs", "cycle"] as const) void this.read(next);
        return;
      }
      if (!group) return;
      if (kind === "members")
        patch = { bots: await readGroupBots(this.peer, group, signal), membersReady: true };
      else if (kind === "tasks")
        patch = await readGroupTasks(
          this.peer,
          this.groupId,
          Math.max(50, this.state.tasks.length),
          signal,
        );
      else if (kind === "cycle")
        patch = {
          cycle: await waitRpc(
            () => this.peer.call("groups.state", { groupId: this.groupId }, { signal }),
            signal,
          ),
        };
      else
        patch = await readGroupRuns(this.peer, this.groupId, signal, (rows) => {
          if (current() && groupRevision === this.revisions.group) {
            this.publish({
              runs: this.runState.reconcile(rows, this.state.runs, true),
              ...(this.runsSettled ? {} : { partialRuns: true }),
            });
          }
        });
      signal.throwIfAborted();
      if (!current() || groupRevision !== this.revisions.group) return;
      if (kind !== "runs" && revision !== this.revisions[kind]) return;
      if (patch.runs) {
        // Partial only when the read itself was cut short; a newer change just schedules the next read.
        patch.runs = this.runState.reconcile(patch.runs, this.state.runs, patch.partialRuns);
      }
      this.failures.delete(kind);
      if (kind === "runs") this.runsSettled = true;
      this.publish({ ...patch, detailsError: this.failures.size > 0 });
      if (kind === "members" && cacheVersion !== undefined)
        this.cache?.writeGroup(this.peer, group, this.state.bots, cacheVersion);
    } catch (error) {
      if (generation !== this.generation || this.lifetime.signal.aborted) return;
      if (groupRevision !== this.revisions.group || revision !== this.revisions[kind]) return;
      if (kind === "group") {
        if (error instanceof RpcError && error.code === RpcErrorCodes.invalidParams) {
          this.cache?.invalidateGroup(this.groupId);
          this.failures.clear();
          this.publish({
            group: undefined,
            bots: [],
            tasks: [],
            runs: [],
            cycle: undefined,
            loading: false,
            identityReady: false,
            membersReady: false,
            error: false,
            detailsError: false,
          });
        } else this.publish({ loading: false, error: true, identityReady: false });
      } else {
        this.failures.add(kind);
        this.publish({ detailsError: true, ...(kind === "runs" ? { partialRuns: true } : {}) });
      }
    }
  }
  refresh = () => {
    if (!this.active) return Promise.resolve();
    this.revisions.group++;
    this.publish({ identityReady: false, membersReady: false });
    return this.read("group");
  };
  more = async () => {
    if (
      !this.active ||
      !this.state.identityReady ||
      this.jobs.has("tasks") ||
      this.state.paging ||
      !this.state.hasMore
    )
      return;
    this.publish({ paging: true });
    const generation = this.generation,
      revision = this.revisions.tasks,
      groupRevision = this.revisions.group;
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
      const page = await waitRpc(
        () =>
          this.peer.call(
            "groups.tasks",
            {
              groupId: this.groupId,
              before: this.state.tasks.at(-1)?.id,
              limit: 50,
            },
            { signal },
          ),
        signal,
      );
      signal.throwIfAborted();
      if (
        generation !== this.generation ||
        revision !== this.revisions.tasks ||
        groupRevision !== this.revisions.group
      )
        return;
      if (page.some((task) => task.groupId !== this.groupId)) throw new Error("Wrong task scope");
      const ids = new Set(this.state.tasks.map((task) => task.id));
      this.publish({
        tasks: [...this.state.tasks, ...page.filter((task) => !ids.has(task.id))],
        hasMore: page.length === 50,
      });
    } catch {
      if (generation === this.generation && !this.lifetime.signal.aborted)
        this.publish({ detailsError: true });
    } finally {
      if (generation === this.generation) {
        this.publish({ paging: false });
        this.schedule();
      }
    }
  };
}
