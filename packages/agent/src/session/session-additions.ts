import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Input = { text: string; mode: "steer" | "followUp"; images?: ImageContent[] };

// The SDK can settle while its asynchronous input hooks are still admitting a message.
// Its native boundary must await admission before deciding whether to continue the run.
export class SessionAdditions {
  private open = false;
  /**
   * Compaction or an automatic retry is under way: the run still continues, so a message sent now
   * waits for it (like OpenCode's compaction barrier) instead of being refused.
   */
  holding = false;
  private readonly waiters = new Set<() => void>();
  readonly pending = new Set<Promise<unknown>>();
  readonly queued = new Map<string, Input>();

  get accepting() {
    return this.open;
  }
  set accepting(value: boolean) {
    this.open = value;
    if (value) this.holding = false;
    if (value || !this.holding) this.wake();
  }
  /** Run over (or refused for good): nothing held may wait any longer. */
  release() {
    this.holding = false;
    this.open = false;
    this.wake();
  }
  private wake() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  /** Resolves when the run accepts input again, gives up for good, or `ms` pass. */
  async waitAccepting(signal: AbortSignal | undefined, ms: number): Promise<boolean> {
    if (this.open) return true;
    if (!this.holding) return false;
    await new Promise<void>((done) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        done();
      }
      this.waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
    return this.open;
  }

  register(pi: ExtensionAPI) {
    pi.on("agent_before_settle", async () => {
      this.accepting = false;
      await Promise.allSettled([...this.pending]);
      this.accepting = this.queued.size > 0;
    });
  }

  take(text: string): string | undefined {
    // Native steering takes precedence over follow-up. Equal outstanding inputs are rejected.
    const found = [...this.queued].find(([, input]) => input.text === text);
    if (!found) return;
    this.queued.delete(found[0]);
    return found[0];
  }
}

type Queue = {
  clearQueue(): { steering: string[]; followUp: string[] };
  steer(text: string, images?: ImageContent[]): Promise<unknown>;
  followUp(text: string, images?: ImageContent[]): Promise<unknown>;
};

/**
 * Switches queued input `id` between "add to the current task" and "after the current task". pi
 * keeps no per-item removal, so its queue is taken out and put back in order: only inputs still in
 * it go back, and the switched input joins the end of its destination queue. One pi already took
 * (in flight, not yet announced) is in neither list, is not added twice, and switching it reports
 * false. Anything pi held that is not matched (another source, or text a skill command expanded)
 * goes back to its own queue unchanged.
 */
export async function requeue(
  additions: SessionAdditions,
  session: Queue,
  id: string,
  mode: "steer" | "followUp",
): Promise<boolean> {
  const cleared = session.clearQueue();
  const tracked = new Map<string, { key: string; input: Input }[]>();
  for (const [key, input] of additions.queued) {
    const lookup = `${input.mode}:${input.text}`;
    const matches = tracked.get(lookup);
    if (matches) matches.push({ key, input });
    else tracked.set(lookup, [{ key, input }]);
  }
  let moved: Input | undefined;
  for (const [queue, texts] of [
    ["steer", cleared.steering],
    ["followUp", cleared.followUp],
  ] as const) {
    for (const text of texts) {
      const match = tracked.get(`${queue}:${text}`)?.shift();
      if (match?.key === id) {
        moved = match.input;
        continue;
      }
      await session[queue](text, match?.input.images);
    }
  }
  if (!moved) return false;
  await session[mode](moved.text, moved.images);
  moved.mode = mode;
  return true;
}
