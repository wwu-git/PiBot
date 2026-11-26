// What Pi tells the person when a management step does not go through: a fixed code plus a
// sentence in their language, never a bare "error". Owner report 2026-11-25: a generic failure left
// Pi guessing ("the system returned an error with no reason").
import type { LocalToolResult } from "@pibot/agent";
import type { CapabilityContext } from "@pibot/brain/kit";
import { RpcError } from "@pibot/protocol";
import { ZodError } from "zod";
import type { Language } from "./lookup.ts";

const REASONS: { match: RegExp; code: string; zh: string; en: string }[] = [
  {
    match: /creation busy|update busy|Bot busy/i,
    code: "bot_busy",
    zh: "这个 Bot 正在被别的操作修改，稍等再试",
    en: "The Bot is being changed by another action; try again shortly",
  },
  {
    match: /Model unavailable|image_model|requireCredentials|credentials/i,
    code: "model_unavailable",
    zh: "选的模型现在不可用（没配好或没有密钥）；换一个模型或用默认模型",
    en: "The chosen model is not available (not set up or no key); pick another or use the default",
  },
  {
    match: /bot_archive_expired/,
    code: "archive_expired",
    zh: "归档超过 30 天，已经不能恢复",
    en: "It was archived more than 30 days ago and can no longer be restored",
  },
  {
    match: /bot_archive_unavailable|Cannot archive main|Unknown active Bot|Archived Bot/i,
    code: "bot_unavailable",
    zh: "这个 Bot 现在不能这样改（已归档、不存在或是你自己）",
    en: "That Bot cannot be changed this way (archived, missing, or yourself)",
  },
  {
    match: /Group busy|Group changing|group_topic_busy|Group message preparing/i,
    code: "group_busy",
    zh: "这个群正在工作或正在被修改，等它停下再试",
    en: "The group is working or being changed; try again when it is idle",
  },
  {
    match: /Cannot remove required member/i,
    code: "group_required_member",
    zh: "不能移出协调者，也不能让群少于 2 个成员",
    en: "The coordinator cannot be removed and a group keeps at least 2 members",
  },
  {
    match: /Unknown group|Invalid group operation/i,
    code: "group_invalid",
    zh: "群组不存在，或这个改动不被允许（成员 2–6 个，名字不能重复）",
    en: "The group does not exist or the change is not allowed (2–6 members, unique name)",
  },
  {
    match: /Brain stopping|closed/i,
    code: "app_stopping",
    zh: "Pi Bot 正在退出，没有完成",
    en: "Pi Bot is shutting down; nothing was done",
  },
];

/**
 * A step that did not go through. Known business errors keep their code and a readable reason;
 * anything else is a program error: it is logged (class name only) and reported as `internal`.
 */
export function managerFailure(
  ctx: Pick<CapabilityContext, "logger">,
  language: Language,
  error: unknown,
  action: string,
): LocalToolResult {
  const message = error instanceof Error ? error.message : "";
  const known =
    error instanceof RpcError ? REASONS.find((reason) => reason.match.test(message)) : undefined;
  const code =
    known?.code ??
    (error instanceof ZodError
      ? "invalid_input"
      : error instanceof RpcError
        ? "refused"
        : "internal");
  if (code === "internal" || code === "invalid_input")
    ctx.logger.warn(
      JSON.stringify({
        module: "pi_manager",
        event: "step_failed",
        action,
        code,
        reason: error instanceof Error ? error.name : typeof error,
      }),
    );
  const reason = known
    ? language === "zh"
      ? known.zh
      : known.en
    : code === "invalid_input"
      ? language === "zh"
        ? "参数不对，按工具说明重写这一步"
        : "The arguments were not valid; rewrite this step as the tool describes"
      : code === "refused"
        ? language === "zh"
          ? `被拒绝：${message.slice(0, 120)}`
          : `Refused: ${message.slice(0, 120)}`
        : language === "zh"
          ? "Pi Bot 内部出错，没有完成；可以告诉用户稍后再试"
          : "Pi Bot hit an internal error and did not finish; tell the person to try again later";
  return {
    isError: true,
    text: `${language === "zh" ? "没有完成" : "Not done"} [${code}]: ${reason}`,
    details: { errorCode: `pi_${code}` },
  };
}
