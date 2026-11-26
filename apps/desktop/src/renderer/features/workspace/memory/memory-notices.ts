import type { TranslationKey } from "@pibot/i18n";
import { type MemoryProposal, type MethodResults, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { actionError, type Peer } from "@pibot/renderer-kit";
import { checkedProfile } from "../profile/profile.ts";
import type { MemoryNoticeStorage } from "./memory-notice-storage.ts";

export function memoryError(error: unknown): TranslationKey {
  if (error instanceof RpcError && error.message === "memory_project_file_changed")
    return "memorySettings.projectFileChanged";
  if (error instanceof RpcError && error.message === "memory_project_target_invalid")
    return "memorySettings.projectTargetInvalid";
  if (error instanceof RpcError && error.message === "memory_move_copy_required")
    return "memorySettings.moveCopyRequired";
  if (error instanceof RpcError && error.message === "memory_move_restore_required")
    return "memorySettings.moveRestoreRequired";
  if (error instanceof RpcError && error.message === "memory_similar")
    return "workspace.memorySimilar";
  if (error instanceof RpcError && error.message === "memory_conflict")
    return "workspace.memoryProposalConflict";
  return error instanceof RpcError && error.code === RpcErrorCodes.timeout
    ? "workspace.memoryUncertain"
    : actionError(error);
}

type NoticePeer = Pick<Peer, "call" | "on">;
export interface MemoryNoticeState {
  profile?: MethodResults["bots.profile"];
  loading: boolean;
  busy: boolean;
  error?: TranslationKey;
  feedback?: { proposal: MemoryProposal; key: TranslationKey };
  dismissed?: ReadonlySet<string>;
}
export const AUTO_NOTICE_MS = 8_000;

// This instance belongs to one peer/Bot/topic mount, never to a mutable global target.
export class MemoryNoticesController {
  private state: MemoryNoticeState = { loading: true, busy: false };
  private listeners = new Set<() => void>();
  private active = false;
  private lifetime = 0;
  private readVersion = 0;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private seenNotices = new Set<string>();
  /** Where each notice was last shown; the brain moves a turn's own note under its reply. */
  private anchors = new Map<string, string | null>();
  constructor(
    private readonly peer: NoticePeer,
    private readonly botId: string,
    private readonly noticeStorage?: MemoryNoticeStorage,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(patch: Partial<MemoryNoticeState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  start() {
    if (!this.active) {
      this.active = true;
      this.lifetime++;
      this.seenNotices.clear();
      this.anchors.clear();
      this.patch({
        profile: undefined,
        feedback: undefined,
        busy: false,
        dismissed: this.noticeStorage?.read() ?? new Set(),
      });
      this.unsubscribe = this.peer.on("memory.changed", (event) => {
        if (event.botId !== this.botId || this.timer) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.refresh();
        }, 250);
      });
    }
    return this.refresh();
  }
  refresh = async () => {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const lifetime = this.lifetime;
    const version = ++this.readVersion;
    const current = () => this.active && lifetime === this.lifetime && version === this.readVersion;
    this.patch({ loading: true, error: undefined });
    try {
      const profile = checkedProfile(
        await this.peer.call("bots.profile", { botId: this.botId }),
        this.botId,
      );
      if (current()) {
        const ids = new Set((profile.undoable ?? []).map((proposal) => proposal.id));
        const dismissed = new Set(
          [...(this.state.dismissed ?? []), ...(this.noticeStorage?.read() ?? [])].filter((id) =>
            ids.has(id),
          ),
        );
        for (const proposal of profile.undoable ?? []) {
          const anchor = this.anchors.get(proposal.id);
          this.anchors.set(proposal.id, proposal.messageId);
          // Moved under the finished reply: show it there once more, even if it faded above.
          if (anchor !== undefined && anchor !== proposal.messageId) {
            dismissed.delete(proposal.id);
            continue;
          }
          if (this.seenNotices.has(proposal.id)) continue;
          this.seenNotices.add(proposal.id);
          // The durable proposal timestamp suppresses old notices after topic/app restart.
          // Do not delete private undo snapshots: dismissing a hint must not alter memory or Undo.
          if (Date.now() - Date.parse(proposal.createdAt) >= AUTO_NOTICE_MS)
            dismissed.add(proposal.id);
        }
        for (const id of this.anchors.keys()) if (!ids.has(id)) this.anchors.delete(id);
        this.seenNotices = ids;
        this.noticeStorage?.write(dismissed);
        this.patch({ profile, dismissed });
      }
    } catch (error) {
      if (current()) this.patch({ profile: undefined, error: memoryError(error) });
    } finally {
      if (current()) this.patch({ loading: false });
    }
  };
  undo = (proposalId: string) => {
    const proposal = this.state.profile?.undoable?.find((p) => p.id === proposalId);
    return proposal ? this.resolveProposal(proposal, false, true) : Promise.resolve();
  };
  dismissNotice = (proposalId: string) => {
    const dismissed = new Set([
      ...(this.state.dismissed ?? []),
      ...(this.noticeStorage?.read() ?? []),
    ]);
    dismissed.add(proposalId);
    this.noticeStorage?.write(dismissed);
    this.patch({ dismissed });
  };
  resolve = (proposalId: string, accept: boolean) => {
    const proposal = this.state.profile?.proposals.find(
      (p) => p.id === proposalId && p.status === "pending",
    );
    return proposal ? this.resolveProposal(proposal, accept, false) : Promise.resolve();
  };
  private async resolveProposal(proposal: MemoryProposal, accept: boolean, undo: boolean) {
    if (!this.active || this.state.busy || this.state.loading) return;
    const lifetime = this.lifetime;
    const current = () => this.active && lifetime === this.lifetime;
    this.patch({ busy: true, error: undefined, feedback: undefined });
    try {
      const result = await this.peer.call("memory.resolve", { proposalId: proposal.id, accept });
      if (!current()) return;
      if (
        result.proposal.id !== proposal.id ||
        result.proposal.botId !== this.botId ||
        result.proposal.action !== proposal.action ||
        result.proposal.messageId !== proposal.messageId ||
        result.proposal.memoryId !== proposal.memoryId ||
        (result.memory && result.memory.scope !== "user" && result.memory.botId !== this.botId)
      )
        throw new Error("Memory resolution target mismatch");
      if (undo)
        this.patch({
          feedback: {
            proposal,
            key:
              result.proposal.status === "rejected"
                ? "workspace.undoDone"
                : "workspace.undoUnavailable",
          },
        });
    } catch (error) {
      if (current()) {
        if (undo)
          this.patch({
            feedback: {
              proposal,
              key:
                error instanceof RpcError && error.code === RpcErrorCodes.busy
                  ? "workspace.undoConflict"
                  : memoryError(error),
            },
          });
        else this.patch({ error: memoryError(error) });
      }
    } finally {
      if (current()) {
        this.patch({ busy: false });
        await this.refresh();
      }
    }
  }
  dispose() {
    this.active = false;
    this.lifetime++;
    this.readVersion++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

export interface MessageMemoryNotices {
  pending: MemoryProposal[];
  undoable: MemoryProposal[];
  feedback?: MemoryNoticeState["feedback"];
}

/**
 * Notices render under the reply that produced them, so group them by message once per state
 * change instead of filtering the whole list for every message row.
 */
export function memoryNoticesByMessage(state: MemoryNoticeState) {
  const groups = new Map<string, MessageMemoryNotices>();
  const group = (messageId: string | null) => {
    if (messageId === null) return undefined;
    let entry = groups.get(messageId);
    if (!entry) {
      entry = { pending: [], undoable: [] };
      groups.set(messageId, entry);
    }
    return entry;
  };
  for (const proposal of state.profile?.undoable ?? [])
    if (!state.dismissed?.has(proposal.id)) group(proposal.messageId)?.undoable.push(proposal);
  for (const proposal of state.profile?.proposals ?? [])
    if (proposal.status === "pending") group(proposal.messageId)?.pending.push(proposal);
  const feedback = state.feedback && group(state.feedback.proposal.messageId);
  if (feedback) feedback.feedback = state.feedback;
  return groups;
}
