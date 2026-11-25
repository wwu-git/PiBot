import { type ExternalAgentId, RpcError } from "@pibot/external-agents-contract/full";
import { externalAgentsZh } from "@pibot/external-agents-contract/i18n";
import { AGENT_LOGOS } from "@pibot/external-agents-contract/logos";
import type { TranslationKey } from "@pibot/i18n";
import { Icon } from "@pibot/ui";
import type { CSSProperties } from "react";
import styles from "./agents.module.css";

/** The vendor's own mark (default avatar of an agent Bot); a neutral tile for a custom command. */
export function AgentLogo({ agentId, size = 42 }: { agentId: ExternalAgentId; size?: number }) {
  const style = { "--logo-size": `${size}px` } as CSSProperties;
  if (agentId === "custom" || !AGENT_LOGOS[agentId])
    return (
      <span className={styles.logo} data-custom style={style} aria-hidden="true">
        <Icon name="terminal" size={Math.round(size * 0.5)} />
      </span>
    );
  return <img className={styles.logo} style={style} src={AGENT_LOGOS[agentId]} alt="" />;
}

/** A refusal code from the brain as a translated sentence; unknown codes never show as text. */
export function errorKey(error: unknown): TranslationKey {
  const code = error instanceof RpcError || error instanceof Error ? error.message : "";
  const key = `errors.${code}`;
  return Object.hasOwn(externalAgentsZh, key) ? (key as TranslationKey) : "errors.internal";
}

export function megabytes(bytes: number) {
  return `${Math.max(0.1, bytes / 1024 / 1024).toFixed(1)} MB`;
}
