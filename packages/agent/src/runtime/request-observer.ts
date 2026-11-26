// Keep accounting attached to the provider attempt independently of reply segmentation.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type AgentError, mapAgentError, transientRequestError } from "../core/errors.ts";
import type {
  AgentErrorCode,
  AgentRequestObserver,
  SessionEvent,
  ToolSetSnapshot,
} from "../core/types.ts";

import type { AgentNetwork } from "../network/network.ts";
import { knownRate } from "./memory-draft.ts";

const amount = z.number().finite().nonnegative();
const tokenUsageSchema = z.object({
  input: amount,
  output: amount,
  cacheRead: amount,
  cacheWrite: amount,
});
const usageSchema = tokenUsageSchema.extend({
  totalTokens: amount.optional(),
  // `totalFromProvider` distinguishes the provider's billed total from a catalog estimate.
  cost: z.object({ total: amount, totalFromProvider: z.boolean().optional() }).optional(),
});
/** result() is the SDK's shared final promise; observing it does not consume streaming events. */
export class RequestAccounting {
  readonly managesRetries = true;
  /**
   * Network/429 retries share one allowance across the run's tool/fix turns; a response that
   * arrives resets it, so it bounds a provider that stays down, not a long run.
   */
  retryAttempts = 0;
  /** The last response ended early because its stream dropped after visible text. */
  interrupted = false;
  /** Preserve classification across the SDK's string-only diagnostic boundary. */
  responseError?: AgentError;
  onReconnect?: (event: Extract<SessionEvent, { type: "reconnect" }>) => void;
  private readonly pending = new Set<Promise<void>>();
  private failure?: unknown;
  blocked?: AgentErrorCode;
  constructor(
    private readonly observer?: AgentRequestObserver,
    private readonly observeRequest?: AgentNetwork["observeRequest"],
  ) {}
  begin(
    model: {
      provider: string;
      api?: string;
      id: string;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    },
    kind: "response" | "compaction" | "auxiliary",
    toolSet?: ToolSetSnapshot,
  ) {
    if (this.failure) throw this.failure;
    const id = randomUUID();
    // An all-zero catalogue entry can be an unpriced subscription. Do not assert free usage.
    const pricingKnown = Object.values(model.cost).some(
      (value) => Number.isFinite(value) && value > 0,
    );
    try {
      this.observer?.beforeRequest({
        id,
        kind,
        provider: model.provider,
        model: model.id,
        pricingKnown,
        ...(toolSet ? { toolSet } : {}),
      });
    } catch (error) {
      this.blocked = mapAgentError(error);
      throw error;
    }
    const startedAt = performance.now();
    let settled = false;
    let cacheFields: Set<string> | undefined;
    return {
      send: <T>(request: () => T): T => {
        if (!this.observer?.metrics || !this.observeRequest) return request();
        return this.observeRequest((fields) => {
          cacheFields ??= new Set();
          for (const field of fields) cacheFields.add(field);
        }, request);
      },
      settle: (
        result?: { stopReason: string; usage?: unknown },
        failure?: { error: unknown; outputObserved: boolean },
      ) => {
        if (settled) return false;
        settled = true;
        const complete =
          !!result && result.stopReason !== "error" && result.stopReason !== "aborted";
        const parsed = usageSchema.safeParse(result?.usage);
        const usage = parsed?.success ? parsed.data : undefined;
        const tokens = usage
          ? (usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite)
          : undefined;
        // Aborted/error SDK messages can carry billed partial usage, or merely default zeroes.
        const knownTokens = tokens !== undefined && (complete || tokens > 0);
        const reportedCost =
          pricingKnown || usage?.cost?.totalFromProvider === true ? usage?.cost?.total : undefined;
        const partialCost =
          !complete && knownTokens && usage && pricingKnown
            ? (usage.input * knownRate(model.cost.input) +
                usage.output * knownRate(model.cost.output) +
                usage.cacheRead * knownRate(model.cost.cacheRead) +
                usage.cacheWrite * knownRate(model.cost.cacheWrite)) /
              1_000_000
            : undefined;
        // Count only tokens the provider actually reported, never estimate unobserved streaming text.
        const cost =
          reportedCost && reportedCost > 0 ? reportedCost : (partialCost ?? reportedCost);
        const knownCost = cost !== undefined && (complete || cost > 0);
        // Missing usage alone proves nothing. Only the stream owner can attest no output;
        // positive partial usage always wins, including tokens on an unpriced provider.
        const unbilled =
          result?.stopReason === "error" &&
          !!failure &&
          !failure.outputObserved &&
          (result.usage === undefined ||
            (usage !== undefined &&
              [
                usage.input,
                usage.output,
                usage.cacheRead,
                usage.cacheWrite,
                usage.totalTokens ?? 0,
                usage.cost?.total ?? 0,
              ].every((value) => value === 0))) &&
          !!transientRequestError(failure.error);
        this.observer?.settled({
          id,
          complete,
          ...(unbilled
            ? { usage: { tokens: 0, costUsd: 0 } }
            : knownTokens || knownCost
              ? {
                  usage: {
                    ...(knownTokens ? { tokens } : {}),
                    ...(knownCost ? { costUsd: cost } : {}),
                  },
                }
              : {}),
        });
        if (this.observer?.metrics) {
          // Custom endpoints can have an unknown (negative) price with valid token counters.
          const parsed = tokenUsageSchema.safeParse(result?.usage);
          const reported = parsed.success ? parsed.data : undefined;
          const tokenUsage =
            reported && (complete || Object.values(reported).some((value) => value > 0))
              ? reported
              : undefined;
          this.observer.metrics({
            startedAt,
            provider: model.provider,
            api: model.api ?? "unknown",
            ...(tokenUsage && { usage: tokenUsage }),
            ...(cacheFields && { cacheFields: [...cacheFields].sort() }),
          });
        }
        return unbilled;
      },
    };
  }
  track(pending: Promise<void>) {
    const observed = pending.catch((error) => {
      this.failure = error;
    });
    this.pending.add(observed);
    void observed.finally(() => this.pending.delete(observed));
  }
  observe<T extends { stopReason: string; usage?: unknown }>(
    receipt: ReturnType<RequestAccounting["begin"]>,
    result: Promise<T>,
  ) {
    const pending = result
      .then(
        (value) => {
          receipt.settle(value);
        },
        () => {
          receipt.settle();
        },
      )
      .catch((error) => {
        this.failure = error;
      });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
  }
  async drain() {
    while (this.pending.size) await Promise.all([...this.pending]);
    if (this.failure) throw this.failure;
  }
}
