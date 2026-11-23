// Why a local MCP did not start, and the per-MCP "run outside the sandbox (as you)"
// switch. Turning it on only asks the brain; the native dialog in the main process is the
// confirmation, so a click here alone never moves an MCP out of the sandbox.
import type {
  Connector,
  ConnectorDiagnostics,
  ConnectorStartFailure,
} from "@pibot/plugins-contract/full";
import { hostPlatform, useSettings } from "@pibot/renderer-kit";
import { Switch } from "@pibot/ui";
import styles from "./connectors.module.css";

type Translate = ReturnType<typeof useSettings>["t"];

function denialText(t: Translate, denial: ConnectorStartFailure["denials"][number]) {
  if (denial.kind === "system_service" && denial.rule === "keychain")
    return t("connectors.startFailure.denial.keychain");
  const key =
    denial.kind === "credential_read" ||
    denial.kind === "protected_read" ||
    denial.kind === "system_service" ||
    denial.kind === "network"
      ? (`connectors.startFailure.denial.${denial.kind}` as const)
      : ("connectors.startFailure.denial.other" as const);
  return t(key, { target: denial.target });
}

/** The fixed reason, the process facts, the sandbox's refusals and the redacted stderr tail. */
export function ConnectorStartFailureView({ failure }: { failure: ConnectorStartFailure }) {
  const { t } = useSettings();
  const facts = [
    t(
      failure.outsideSandbox
        ? "connectors.startFailure.where.outside"
        : "connectors.startFailure.where.sandbox",
    ),
    failure.timedOut ? t("connectors.startFailure.timedOut") : undefined,
    failure.exitCode !== null
      ? t("connectors.startFailure.exitCode", { code: String(failure.exitCode) })
      : undefined,
    failure.signal ? t("connectors.startFailure.signal", { signal: failure.signal }) : undefined,
  ].filter(Boolean);
  const login = failure.reason === "password_prompt" || failure.reason === "login_required";
  return (
    <section className={`${styles.warn} ${styles.stack}`} aria-live="polite">
      <strong>{t("connectors.startFailure.title")}</strong>
      <p>
        {t(
          failure.reason === "command_not_found" && hostPlatform() === "win32"
            ? "connectors.startFailure.reason.command_not_found_windows"
            : `connectors.startFailure.reason.${failure.reason}`,
        )}
      </p>
      {login && <p className={styles.note}>{t("connectors.startFailure.loginHint")}</p>}
      <p className={styles.note}>{facts.join(" · ")}</p>
      {failure.denials.length > 0 && (
        <div>
          <p className={styles.note}>{t("connectors.startFailure.denials")}</p>
          <ul className={styles.failureList}>
            {failure.denials.map((denial) => (
              <li key={`${denial.kind}:${denial.rule}:${denial.target}`}>
                {denialText(t, denial)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {failure.stderrTail.trim() && (
        <details>
          <summary className={styles.note}>{t("connectors.startFailure.stderr")}</summary>
          <pre className={styles.stderrTail}>{failure.stderrTail.trim()}</pre>
        </details>
      )}
    </section>
  );
}

export function ConnectorSandboxSection({
  connector,
  diagnostics,
  disabled,
  toggle,
}: {
  connector: Connector;
  diagnostics: ConnectorDiagnostics;
  disabled: boolean;
  toggle(enabled: boolean): void;
}) {
  const { t } = useSettings();
  // Windows keeps its own S3-W note (every local MCP there already runs unisolated).
  if (diagnostics.outsideSandbox !== "available") return null;
  return (
    <section className={styles.stack}>
      <h3>{t("connectors.outsideSandbox.title")}</h3>
      <div className={styles.row}>
        <span className={styles.grow}>{t("connectors.outsideSandbox.switch")}</span>
        <Switch
          checked={connector.outsideSandbox}
          label={t("connectors.outsideSandbox.switch")}
          disabled={disabled}
          onCheckedChange={toggle}
        />
      </div>
      {diagnostics.suggestion && !connector.outsideSandbox && (
        <p className={styles.warn}>
          {t(`connectors.outsideSandbox.suggest.${diagnostics.suggestion}`)}
        </p>
      )}
      {connector.outsideSandbox && (
        <p className={styles.warn}>
          {t(
            diagnostics.needsReconfirm
              ? "connectors.outsideSandbox.reconfirm"
              : connector.status === "ready" || connector.status === "idle"
                ? "connectors.outsideSandbox.on"
                : "connectors.outsideSandbox.enabled",
          )}
        </p>
      )}
      <p className={styles.note}>{t("connectors.outsideSandbox.note")}</p>
    </section>
  );
}
