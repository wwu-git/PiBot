import { type ChatPeer, deliveryItemRow } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import type { Bot, GroupTask, GroupTaskBrief, GroupTaskBriefStep } from "@pibot/protocol";
import { BotAvatar, useSettings } from "@pibot/renderer-kit";
import { Icon, type IconName, IconTile, type Tone } from "@pibot/ui";
import { type ReactNode, useContext, useState } from "react";
import { Markdown } from "../../chat/messages/Markdown.tsx";
import { OfficePreviewContext } from "../../office/preview-context.tsx";
import { inboxAge } from "../../workspace/inbox/InboxOriginCard.tsx";
import styles from "../group.module.css";
import { GroupFileBrowser } from "../resources/files.ts";

type BriefState = "done" | "todo" | "wait" | "fail";
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function StateMark({ state, label }: { state: BriefState; label: string }) {
  return (
    <span className={styles.briefState} data-state={state} role="img" aria-label={label}>
      {state === "done" && <Icon name="check" size={11} strokeWidth={3} />}
      {state === "wait" && <Icon name="user" size={11} strokeWidth={2.6} />}
      {state === "fail" && <Icon name="close" size={11} strokeWidth={3} />}
    </span>
  );
}

function Card({
  icon,
  tone,
  title,
  note,
  children,
}: {
  icon: IconName;
  tone: Tone;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.briefCard} aria-label={title}>
      <div className={styles.briefCardHead}>
        <IconTile icon={icon} tone={tone} className={styles.briefTile} />
        <h3>{title}</h3>
        {note && <span className={styles.briefCardNote}>{note}</span>}
      </div>
      <div className={styles.briefCardBody}>{children}</div>
    </section>
  );
}

function FlowNode({
  steps,
  bots,
  current,
  many,
}: {
  steps: GroupTaskBriefStep[];
  bots: Bot[];
  current?: boolean;
  many?: string;
}) {
  const { t } = useSettings();
  const first = steps[0];
  if (!first) return null;
  const done = steps.every((step) => step.status === "passed" || step.status === "skipped");
  const name = (step: GroupTaskBriefStep) =>
    bots.find((bot) => bot.id === step.ownerBotId)?.name ?? step.ownerBotId;
  return (
    <div
      className={styles.briefFlowNode}
      data-current={current || undefined}
      data-done={done || undefined}
      title={steps.map((step) => `${name(step)} · ${step.title}`).join("\n")}
    >
      <span className={styles.briefFlowAvatars}>
        {steps.slice(0, 3).map((step) => (
          <BotAvatar
            key={step.stepId}
            bot={bots.find((bot) => bot.id === step.ownerBotId)}
            unknown
            label={name(step)}
            size={22}
          />
        ))}
        {done && !current && (
          <span className={styles.briefFlowBadge} role="img" aria-label={t("group.brief.stepDone")}>
            <Icon name="check" size={9} strokeWidth={3.4} />
          </span>
        )}
      </span>
      <span className={styles.briefFlowText}>
        <span>{steps.length > 1 ? many : name(first)}</span>
        <strong>
          {steps.length > 1 ? steps.map((step) => step.title).join(" · ") : first.title}
        </strong>
      </span>
    </div>
  );
}

/** Previous step(s) → this step → next step(s), each with its owner. */
export function TaskBriefFlow({ brief, bots }: { brief: GroupTaskBrief; bots: Bot[] }) {
  const { t } = useSettings();
  if (!brief.previous.length && !brief.next.length) return null;
  const arrow = (
    <span className={styles.briefFlowArrow} aria-hidden="true">
      <Icon name="arrow" size={14} />
    </span>
  );
  return (
    <nav className={styles.briefFlow} aria-label={t("group.brief.flow")}>
      {brief.previous.length > 0 && (
        <>
          <FlowNode
            steps={brief.previous}
            bots={bots}
            many={t("group.brief.prevMany", { count: brief.previous.length })}
          />
          {arrow}
        </>
      )}
      <FlowNode steps={[brief.step]} bots={bots} current />
      {brief.next.length > 0 && (
        <>
          {arrow}
          <FlowNode
            steps={brief.next}
            bots={bots}
            many={t("group.brief.nextMany", { count: brief.next.length })}
          />
        </>
      )}
    </nav>
  );
}

/** Opens a delivered file the way the group's file list does (preview, else the system app). */
function useOpenFile(peer: ChatPeer, groupId: string) {
  const preview = useContext(OfficePreviewContext);
  const [busy, setBusy] = useState<string>();
  const open = async (target: { folderId: string; path: string }) => {
    if (busy) return;
    setBusy(target.path);
    const parent = target.path.split("/").slice(0, -1).join("/");
    const browser = new GroupFileBrowser(
      peer,
      groupId,
      parent,
      target.folderId,
      (name, groupFile) => preview?.({ name, source: { groupFile } }),
    );
    const stop = browser.start();
    try {
      // The browser opens only a path its own listing returned, with that listing's root token.
      if (browser.getSnapshot().busy)
        await new Promise<void>((resolve) => {
          const off = browser.subscribe(() => {
            if (browser.getSnapshot().busy) return;
            off();
            resolve();
          });
        });
      await browser.open(target.path);
    } finally {
      stop();
      setBusy(undefined);
    }
  };
  return { open, busy };
}

export function TaskBriefCards({
  peer,
  brief,
  bots,
  task,
}: {
  peer: ChatPeer;
  brief: GroupTaskBrief;
  bots: Bot[];
  task: GroupTask;
}) {
  const { t, language } = useSettings();
  const files = useOpenFile(peer, task.groupId);
  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
  const delivered = brief.deliverables.filter((item) => item.delivered).length;
  const manual = brief.acceptance.some((item) => item.by === "person");
  const checks = new Map((task.handoff?.items ?? []).map((item) => [item.id, item]));
  const stateLabel = (state: GroupTaskBrief["acceptance"][number]["state"]) =>
    t(`group.brief.state.${state}` as TranslationKey);
  return (
    <>
      <Card icon="plan" tone="blue" title={t("group.brief.what")}>
        <div className={styles.briefMarkdown}>
          {brief.task !== null ? (
            <Markdown text={brief.task} />
          ) : (
            <p>{t("group.brief.skill", { name: brief.skill ?? "" })}</p>
          )}
        </div>
      </Card>
      {(brief.inputFiles.length > 0 || brief.inputs.length > 0) && (
        <Card icon="inbox" tone="green" title={t("group.brief.uses")}>
          {brief.inputFiles.map((item) => {
            const ready = item.from.status === "passed";
            return (
              <div key={`${item.from.stepId}:${item.path}`} className={styles.briefInputFile}>
                <span className={styles.briefFileChip} title={item.path}>
                  <Icon name="file" size={14} />
                  <span>{item.path}</span>
                </span>
                <span className={styles.briefMuted}>
                  {t("group.brief.from", {
                    name: botName(item.from.ownerBotId),
                    index: item.from.index,
                  })}
                </span>
                <StateMark
                  state={ready ? "done" : "todo"}
                  label={t(ready ? "group.brief.inputReady" : "group.brief.inputWaiting")}
                />
              </div>
            );
          })}
          {brief.inputs.length > 0 && (
            <dl className={styles.briefInputs}>
              {brief.inputs.map((item) => (
                <div key={item.name}>
                  <dt>{item.name}</dt>
                  <dd data-kind={item.kind}>{item.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      )}
      {brief.deliverables.length > 0 && (
        <Card
          icon="box"
          tone="violet"
          title={t("group.brief.deliver")}
          note={t("group.brief.deliveredCount", {
            done: delivered,
            total: brief.deliverables.length,
          })}
        >
          <div
            className={styles.briefProgress}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={brief.deliverables.length}
            aria-valuenow={delivered}
            aria-label={t("group.brief.deliver")}
          >
            <span style={{ width: `${(delivered / brief.deliverables.length) * 100}%` }} />
          </div>
          <ul className={styles.briefRows}>
            {brief.deliverables.map((item) => {
              const status = item.delivered
                ? item.deliveredAt
                  ? t("group.brief.deliveredAt", {
                      time: inboxAge(item.deliveredAt, language, t("workspace.inboxJustNow")),
                    })
                  : t("group.brief.delivered")
                : t("group.brief.notYet");
              const content = (
                <>
                  <Icon name={IMAGE.test(item.path) ? "image" : "file"} size={16} />
                  <code title={item.path}>{item.path}</code>
                  <span className={styles.briefMuted}>{status}</span>
                  <StateMark state={item.delivered ? "done" : "todo"} label={status} />
                </>
              );
              const target = item.open;
              return (
                <li key={item.id} data-delivered={item.delivered || undefined}>
                  {target ? (
                    <button
                      type="button"
                      className={styles.briefRowButton}
                      aria-label={t("group.brief.open", { path: item.path })}
                      disabled={!!files.busy}
                      aria-busy={files.busy === target.path}
                      onClick={() => void files.open(target)}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className={styles.briefRowButton}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {brief.acceptance.length > 0 && (
        <Card icon="shield" tone="pink" title={t("group.brief.pass")}>
          <p className={styles.briefNote}>
            {t(manual ? "group.brief.passNoteManual" : "group.brief.passNote")}
          </p>
          <ul className={styles.briefRows}>
            {brief.acceptance.map((item) => {
              const checked = checks.get(item.id);
              const row = checked ? deliveryItemRow(checked, t) : undefined;
              const label =
                item.text ??
                `${t(`receipt.delivery.check.${item.check}` as TranslationKey)}${item.deliverable ? ` · ${item.deliverable}` : ""}`;
              return (
                <li key={item.id} className={styles.briefCheck}>
                  <StateMark
                    state={
                      item.state === "pass"
                        ? "done"
                        : item.state === "fail"
                          ? "fail"
                          : item.state === "waiting"
                            ? "wait"
                            : "todo"
                    }
                    label={stateLabel(item.state)}
                  />
                  <span className={styles.briefCheckText}>
                    {label}
                    {item.state === "fail" && row && <small>{row.value}</small>}
                  </span>
                  <span className={styles.briefTag}>
                    {t(item.by === "person" ? "group.brief.byYou" : "group.brief.byProgram")}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <Card icon="folder" tone="orange" title={t("group.brief.where")}>
        <span className={styles.briefFolder} title={brief.folder.path}>
          <Icon name="folder" size={14} />
          <span>{brief.folder.label}</span>
        </span>
        <p className={styles.briefNote}>
          {t(brief.workspace === "own" ? "group.brief.own" : "group.brief.shared")}
        </p>
        {brief.next.length > 0 ? (
          <div className={styles.briefNext}>
            <span>{t("group.brief.then")}</span>
            {brief.next.map((step) => (
              <span key={step.stepId} className={styles.briefNextStep}>
                <BotAvatar
                  bot={bots.find((bot) => bot.id === step.ownerBotId)}
                  unknown
                  label={botName(step.ownerBotId)}
                  size={18}
                />
                <strong>
                  {botName(step.ownerBotId)} · {step.title}
                </strong>
              </span>
            ))}
          </div>
        ) : (
          <p className={styles.briefNote}>{t("group.brief.last")}</p>
        )}
      </Card>
    </>
  );
}
