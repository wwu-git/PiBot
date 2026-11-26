import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PromptContext, WorkflowSkillReference } from "../core/types.ts";
import { contextBlocks } from "./context-reference.ts";
import { PromptBudgetError, type PromptFailure } from "./group-header.ts";
import { groupProfile } from "./group-reference.ts";
import { RunReferences } from "./reference-layout.ts";
import { RunStates } from "./state-layout.ts";
import { stateEntry, type TranscriptPort } from "./transcript-entries.ts";
import {
  disarmStateMarker,
  moveCacheBreakpointOffState,
  placeSystemMessages,
  STATE_NOTICE,
  stateAsDeveloperMessage,
} from "./volatile-state.ts";

export interface PromptState {
  current?: PromptContext;
  refresh?(signal: AbortSignal): PromptContext | Promise<PromptContext>;
  signal?: AbortSignal;
  revision?: number;
  maxBytes?: number;
  /** Set when the hook stopped the run itself; the session reports it instead of "aborted". */
  failure?: PromptFailure;
  /** Where state and reference messages are persisted for later runs of the session. */
  transcript?: TranscriptPort;
  /** SEC: a workflow run's skill text, shown in the run's context reference message. */
  workflowSkill?: WorkflowSkillReference;
}

export function registerPromptContext(pi: ExtensionAPI, state?: PromptState) {
  if (!state) return;
  let profile: string | undefined;
  const references = new RunReferences(state.transcript);
  const states = new RunStates(state.transcript);
  // Exact texts of the state messages in the request being built; pi runs `context` and then
  // `before_provider_request` for each request of a session in turn.
  let stateTexts: ReadonlySet<string> = new Set();
  pi.on("before_agent_start", (event) => {
    // Both user and custom triggers start a new run in pi 1.6.0. Reset once here,
    // never per turn; custom messages queued into an active run do not fire this hook.
    delete event.systemPromptOptions.sections.pibot_secrets;
    delete event.systemPromptOptions.sections.pibot_memory;
    delete event.systemPromptOptions.sections.pibot_workplace;
    delete event.systemPromptOptions.sections.pibot_project;
    delete event.systemPromptOptions.sections.pibot_execution;
    delete event.systemPromptOptions.sections.pibot_routine;
    delete event.systemPromptOptions.sections.pibot_routine_resume;
    delete event.systemPromptOptions.sections.pibot_group;
    // SEC: memory, working location, project notes and a workflow skill's text are not system
    // content (they can carry what the Bot read from pages, files or a plugin); they ride in the
    // run's context reference message instead. The deletes above still clear the sections that
    // sessions of earlier versions carried.
    references.reset(contextBlocks(state.current, state.workflowSkill));
    states.reset();
    profile = groupProfile(state.current?.group, state.maxBytes ?? 64000);
    if (profile) event.systemPromptOptions.sections.pibot_group = profile;
    if (state.current?.availableSecrets)
      event.systemPromptOptions.sections.pibot_secrets = state.current.availableSecrets;
    // Execution state and routine results change between turns (a TODO update bumps the plan
    // version). They ride along as transient messages instead (`RunStates`, `RunReferences`), so
    // a mid-conversation change cannot invalidate the cached prefix that starts with this prompt.
    event.systemPromptOptions.sections.pibot_state_notice = STATE_NOTICE;
  });
  pi.on(
    "before_provider_request",
    (event, ctx) =>
      moveCacheBreakpointOffState(event.payload) ??
      stateAsDeveloperMessage(event.payload, ctx.model, stateTexts),
  );
  // `context_with_system`, so pi's system messages (tool loads, prompt updates) are not
  // merged into the leading one when this hook changes the conversation (`placeSystemMessages`).
  pi.on("context_with_system", async (event, ctx) => {
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(20_000),
        ...(state.signal ? [state.signal] : []),
      ]);
      signal.throwIfAborted();
      const revision = (state.revision ?? 0) + 1;
      state.revision = revision;
      if (state.refresh) {
        const current = await state.refresh(signal);
        signal.throwIfAborted();
        if (state.revision !== revision) throw new Error("Group context refresh superseded");
        state.current = current;
      }
      const group = state.current?.group;
      const maxBytes = state.maxBytes ?? 64000;
      let currentProfile: string | undefined;
      if (group) {
        if (profile === undefined) throw new PromptBudgetError();
        // Keep this run's system prefix fixed; refreshed membership and announcement data still
        // reach the model without interrupting ongoing work. Brain validates access on refresh.
        currentProfile = groupProfile(group, maxBytes);
        if (currentProfile === undefined) throw new PromptBudgetError();
      } else if (profile) throw new Error("Group context unavailable");
      // History is checkpointed at complete tool boundaries. Serialized signatures and JSONL
      // metadata are not model tokens and must never silently evict whole user turns here.
      // System messages pass through untouched (never anchors of their own, never rewritten).
      const disarmed = disarmStateMarker(event.messages, (m) => !!stateEntry(m));
      const messages = references.apply(disarmed, {
        ...(state.current ? { current: state.current } : {}),
        ...(profile !== undefined ? { profile } : {}),
        ...(currentProfile !== undefined ? { currentProfile } : {}),
        canSee: ctx.model?.input.includes("image") === true,
        maxBytes,
      });
      // Pi Bot's own limits: append-only state messages for every provider (the provider hook sends
      // them as developer messages on Responses APIs), shown before the user's message.
      const placed = states.apply(messages, state.current);
      stateTexts = placed.texts;
      return { messages: placeSystemMessages(placed.messages, ctx.model) };
    } catch (error) {
      // pi catches hook exceptions. Explicitly abort, rather than throwing into a fail-open hook.
      // A user stop also lands here; the session gives that precedence over this failure.
      state.failure =
        error instanceof PromptBudgetError ? "context_too_large" : "context_unavailable";
      ctx.abort();
      // No conversation at all; the leading system message stays so pi reports nothing extra.
      return { messages: event.messages.filter((m) => m.role === "system").slice(0, 1) };
    }
  });
}
