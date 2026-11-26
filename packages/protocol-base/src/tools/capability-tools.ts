import type { z } from "zod";
import type { ToolAttributes } from "./tool-attributes.ts";

/**
 * A model-facing tool that a capability contributes. The declaration is contract data:
 * the model's tool catalog must exist before any session starts, and the kernel keeps its static
 * tool typing by reading these through the `protocol` aggregate. Execution is registered at
 * runtime by the capability (`ctx.tools.executor`); without it the tool fails closed.
 */
export interface CapabilityToolSpec {
  /**
   * Lazy-load group (`tool_discover`); one of the capability's `CapabilityToolGroup` ids. Without a
   * group the tool is offered directly, like the kernel's core tools.
   */
  group?: string;
  /** Offered only inside an unattended run (a scheduled task's own bookkeeping). */
  unattendedOnly?: boolean;
  /**
   * Offered and allowed only in the default Pi's own direct chat, typed by the person on this
   * computer (owner decision 2026-11-24). The kernel decides this, never the capability: the
   * catalog hides the tool everywhere else and policy refuses a call that reaches it anyway.
   */
  mainBotOnly?: true;
  /** Product-managed role eligibility; executors must also recheck at dispatch. */
  roleIds?: readonly string[];
  /** Returns an image to the model: offered only to models that accept image input. */
  imageInput?: boolean;
  /** System-prompt rule added when this tool is directly available (tools without a group). */
  rule?: { zh: string; en: string };
  schema: z.ZodType;
  /** Shown to the model; English, like the kernel's tool descriptions. */
  description: string;
  /**
   * What a call does beyond its policy request. Declared here so the lists derived from
   * tool behaviour (write deliveries, audit rows) read the registration instead of copying names.
   */
  attributes?: ToolAttributes;
  /**
   * The request every call is judged as by `packages/policy`. A constant: a capability chooses
   * an existing policy category, it cannot add a bypass.
   */
  policy: { category: string; operation?: string; path?: string };
}

export interface CapabilityToolGroup {
  id: string;
  /** Bilingual one-liner listed by `tool_discover`. */
  description: string;
  /** System-prompt rule added when any of the group's tools is directly available. */
  rule: { zh: string; en: string };
}

/** Runtime registry assembled by the product composition root and consumed by the kernel. */
export interface CapabilityToolRegistry {
  readonly specs: Readonly<Record<string, CapabilityToolSpec>>;
  readonly groups: readonly CapabilityToolGroup[];
}
