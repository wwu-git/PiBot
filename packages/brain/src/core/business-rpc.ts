import type { KernelMethodParams, KernelMethodResults, KernelMethods } from "@pibot/protocol-base";
export interface RpcRequestContext {
  signal: AbortSignal;
  source?: "acp";
  /** Assigned by the authenticated host port, never by request parameters. */
  desktopMain?: boolean;
  /** The paired phone sent this request; assigned by the remote kernel bridge, never by params. */
  phone?: boolean;
}
export type KernelRegisterRpc = <K extends keyof typeof KernelMethods>(
  method: K,
  action: (
    params: KernelMethodParams[K],
    context: RpcRequestContext,
  ) => Promise<KernelMethodResults[K]>,
) => void;

/**
 * Capability-facing registration seam. Runtime schemas come from the product composition root;
 * each capability keeps its concrete handler typing in its own contract package.
 */
export type RegisterRpc = (
  method: string,
  // biome-ignore lint/suspicious/noExplicitAny: product-composed schemas validate this erased seam.
  action: (params: any, context: RpcRequestContext) => Promise<any> | any,
) => void;
