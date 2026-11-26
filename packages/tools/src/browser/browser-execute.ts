import { RpcError } from "@pibot/protocol-base";
import type {
  BrowserToolInput,
  PreparedToolView,
  ToolResult,
  ToolRuntime,
} from "../runtime/tool-runtime.ts";
import { describe, PICTURED_ACTIONS } from "./browser-actions.ts";
import { blockedNote, blockedReasonNote, handleBlocked } from "./browser-blocked.ts";

export const BROWSER_TAKEOVER_STOP =
  "用户正在接管浏览器，本轮停止浏览器操作。保留产物和入口并告诉用户当前结果；不要 sleep 等待、反复调用或换端口/重启服务绕过接管。用户交还后可在新的运行中继续 / The user controls the browser. Stop browser actions for this turn, preserve and report outputs/entry points. Do not sleep, retry or change ports/restart services to evade takeover. A new run can continue after hand-back.";
export const BROWSER_SCREENSHOT_STOP =
  "截图不可用，本轮不再重复截图。可用页面快照读取内容，但不能当成视觉验证；如实交付已生成的文件和入口，说明未视觉核验，不要 sleep 等待、重启服务或反复重开页面只为截图 / Screenshot unavailable; do not repeat screenshots this turn. A page snapshot can read content but is not visual verification. Deliver existing files/entry points and disclose the missing visual check. Do not sleep, restart services or repeatedly reopen pages just to capture.";
/**
 * The first missing picture is retried by the host once already; the model gets one more
 * try before the turn's visual check is declared impossible. One failed capture used to end
 * screenshots for the whole turn, and the Bot shipped a page it never looked at.
 */
export const BROWSER_SCREENSHOT_RETRY =
  "截图这次没拿到画面（页面可能还在绘制或很忙），已自动重试过一次。请再调用一次 browser_screenshot；再失败才说明未做视觉核验 / The screenshot got no picture (the page may still be drawing or busy), even after one automatic retry. Call browser_screenshot once more; only if that fails too, report that the visual check could not be done.";
export const BROWSER_RESOURCE_BUSY =
  "浏览器正被另一个运行使用，请稍后重试 / The browser is busy with another run; retry later";

const TAKEOVER_WAIT_MS = 10 * 60 * 1000;
const TAKEOVER_POLL_MS = 2000;
const STEP_PICTURE_TIMEOUT_MS = 5000;
const RETRYABLE = new Set([
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_back",
]);

const errors: Record<string, string> = {
  browser_private_open_required:
    "用户浏览器扩展不能安全访问此内网目标，刚才的点击或表单没有转移或重放。请用 browser_open 明确打开目标网址，改用独立 Bot 浏览器并重新读取快照；不要自动重放原表单 / The browser extension cannot safely reach this private target. The click or form was not transferred or replayed. Explicitly open the target URL with browser_open to use the isolated Bot browser, then take a fresh snapshot. Do not automatically replay the original form",
  browser_snapshot_stale:
    "页面在读取时变了，请重新读取快照 / The page changed while reading; take a new snapshot",
  browser_screenshot_stale:
    "截图已失效，请重新截图后再按位置点击 / The screenshot expired or the page changed; take a new screenshot before clicking by position",
  browser_resource_busy: BROWSER_RESOURCE_BUSY,
  browser_takeover: BROWSER_TAKEOVER_STOP,
  browser_pages_closed_open_again:
    "浏览器页面已关闭（空闲或给其他 Bot 让位），登录状态还在；请用 browser_open 重新打开 / The browser pages were closed (idle or for another Bot); logins are kept, reopen with browser_open",
  browser_bot_limit:
    "同时使用浏览器的 Bot 太多，请稍后重试 / Too many Bots are using their browsers; retry later",
  browser_reveal_field:
    "密码、验证码和银行卡字段不能用 browser_type 输入。用户在 Pi Bot 设置 → 权限 → 密码里为这个网站保存了账号时，用 browser_login 登录（看不到它就先 tool_discover 打开 browser 组）：账号和密码都由它自己填，包括先填账号、点继续再出现密码框的两步登录。不要告诉用户你不能填密码，也不要让用户自己输入已保存的密码；只有验证码、人机验证、银行卡或没有保存账号时才请用户接管 / Passwords, codes and card fields cannot be typed with browser_type. If the user saved an account for this site in Pi Bot (Settings → Permissions → Passwords), use browser_login (load it with tool_discover, group browser, if it is not visible): it fills the account and the password itself, two-step logins included. Never tell the user you cannot fill their saved password and never ask them to type it; ask the user to take over only for a code, a human check, a card or when no account is saved",
  browser_ref_not_found:
    "找不到这个元素，请重新 browser_snapshot / Element not found; take a new browser_snapshot",
  browser_ref_not_visible:
    "元素不可见，请先滚动或重新快照 / Element not visible; scroll or snapshot again",
  browser_ref_not_editable: "这个元素不能输入 / This element is not editable",
  browser_option_not_found: "没有这个选项 / No such option",
  browser_tab_not_found: "没有这个标签页 / No such tab",
  browser_tab_closed: "标签页已关闭 / The tab is closed",
  browser_tab_closed_by_user:
    "用户关闭了标签页；请换别的办法（browser_tabs 看剩下的标签页，或 browser_open 重新打开） / The user closed the tab; try another way (browser_tabs lists the remaining tabs, browser_open opens a page again)",
  browser_tab_limit: "标签页太多，请先关闭一些 / Too many tabs; close some first",
  browser_timeout: "网页操作超时 / The page action timed out",
  browser_unsupported_url:
    "只能打开 http(s) 网址或工作位置内的 HTML / 图片 / PDF / Only http(s) URLs or HTML, images and PDF files within the workplace can be opened",
  browser_wait_value_required:
    "等待文字或元素时需要 value / value is required to wait for text or a ref",
  browser_screenshot_too_large:
    "截图太大，请不用 fullPage / The screenshot is too large; omit fullPage",
  browser_screenshot_frame_timeout:
    "截图超时：Chromium 没有及时返回画面（已自动重试一次） / Screenshot timed out: Chromium did not return a frame in time (already retried once)",
  browser_screenshot_unavailable: BROWSER_SCREENSHOT_RETRY,
  browser_unavailable:
    "这台电脑上不能使用 Bot 浏览器 / The Bot browser is unavailable on this host",
  browser_closed: "Bot 浏览器已关闭 / The Bot browser is closed",
  browser_selection_stale: "页面已变化，请重读快照后选择 / The page changed; take a fresh snapshot",
  secret_redaction_budget_exceeded:
    "秘密保护预算已用完，未执行 / Secret protection budget exhausted; not executed",
  secret_handle_refused: "秘密句柄无效或已过期 / Invalid or expired secret handle",
  secret_output_withheld: "secret_output_withheld",
  browser_network_refused:
    "请求或句柄被拒绝：请核对当前页面源、参数和句柄 / Request or handle refused: check the current origin, parameters and handle",
  browser_debug_unsupported: "此浏览器不支持调试 / Browser debugging is unavailable",
  browser_inspect_unavailable:
    "无法检查这个元素或嵌入页面 / This element or embedded frame cannot be inspected",
  browser_viewport_restore_failed:
    "无法恢复预览尺寸，页面已关闭 / The preview size could not be restored; its page was closed",
};

function hostError(error: unknown): string | undefined {
  return error instanceof RpcError
    ? (errors[error.message] ?? "网页操作失败 / The browser action failed")
    : undefined;
}

/** Host codes are fixed identifiers; logging them names the failing layer. */
function hostErrorCode(error: unknown) {
  return error instanceof RpcError && /^[a-z][a-z0-9_]{0,79}$/.test(error.message)
    ? error.message
    : undefined;
}

export async function browserDelay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function executeBrowser(
  runtime: ToolRuntime,
  prepared: PreparedToolView,
  input: BrowserToolInput,
  signal: AbortSignal,
): Promise<ToolResult> {
  const browser = runtime.browser;
  if (!browser) return { text: errors.browser_unavailable as string, isError: true };
  browser.assertRun();
  const stopped = browser.retryBoundary(input.tool);
  if (stopped) return { text: stopped, isError: true };
  browser.approveInitialSite(prepared);
  const writeRoot = runtime.writeRoots(prepared)[0];
  const configure = (force = false) => browser.configure(prepared, writeRoot, signal, force);
  const described = describe(input);
  const step = (
    result: "done" | "error" | "denied",
    image?: Parameters<typeof browser.recordStep>[0]["image"],
    page?: Parameters<typeof browser.recordStep>[0]["page"],
  ) =>
    described &&
    browser.recordStep({
      toolCallId: prepared.call.id,
      ...described,
      result,
      ...(image ? { image } : {}),
      ...(page ? { page } : {}),
    });
  const picture = async (page: Parameters<typeof browser.screenshot>[0] | undefined) => {
    if (!page || !PICTURED_ACTIONS.has(input.tool) || browser.retryBoundary("step_picture"))
      return undefined;
    try {
      return await browser.screenshot(
        page,
        AbortSignal.any([signal, AbortSignal.timeout(STEP_PICTURE_TIMEOUT_MS)]),
      );
    } catch (error) {
      if (error instanceof RpcError && error.message === "browser_takeover")
        browser.stopRetries("takeover");
      // The step thumbnail is only a record. Its miss stops further thumbnails (each could cost
      // the full timeout), never the model's own visual check.
      else if (!signal.aborted) browser.stopRetries("step_picture");
      return undefined;
    }
  };
  const call = async () => {
    try {
      return await browser.action(input, signal);
    } finally {
      if (input.tool === "browser_diagnostics" || input.tool === "browser_inspect")
        browser.auditInspection(input.tool, prepared.call.id);
    }
  };
  const attempt = async () => {
    const deadline = Date.now() + TAKEOVER_WAIT_MS;
    let waited = false;
    for (;;) {
      try {
        return { ...(await call()), waited };
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        if (error.message === "browser_not_configured") {
          await configure(true);
          return { ...(await call()), waited };
        }
        if (error.message !== "browser_takeover" || browser.isYolo() || Date.now() > deadline)
          throw error;
        waited = true;
        browser.pauseTakeover();
        try {
          await browserDelay(TAKEOVER_POLL_MS, signal);
        } finally {
          browser.resumeTakeover();
        }
      }
    }
  };
  try {
    await configure();
    let result = await attempt();
    if (input.tool === "browser_secret") return { text: result.text };
    const notes: string[] = [];
    if (result.page) {
      const asked = await handleBlocked(
        browser,
        prepared.call,
        result.page.blocked,
        writeRoot,
        signal,
      );
      notes.push(...asked.notes);
      if (asked.approved) {
        await configure();
        if (
          RETRYABLE.has(input.tool) &&
          !(input.tool === "browser_click" && "screenshotId" in input.args)
        ) {
          result = await attempt();
          if (result.page?.blocked.length)
            notes.push(...result.page.blocked.map((entry) => blockedNote(entry)));
        } else notes.push("已获允许，可重试刚才的操作 / Allowed; you can retry the last step");
      }
    }
    if (result.page?.blockedReason)
      notes.push(blockedReasonNote(result.page.blockedReason, browser.googleCompatibility()));
    if (result.page) browser.observe(result.page);
    else if (input.tool === "browser_close") browser.forgetPage();
    const userOpened = browser.takeUserOpened();
    if (userOpened) notes.push(`用户刚才打开了 ${userOpened} / The user just opened ${userOpened}`);
    const handedBack = browser.takeHandBack();
    if (handedBack !== undefined || result.waited) {
      const full =
        result.page?.url ?? (input.tool === "browser_close" ? undefined : handedBack || undefined);
      const url = full && withoutQuery(full);
      notes.push(
        url
          ? `用户刚才操作过浏览器，当前网址 ${url} / The user just used the browser; current URL ${url}`
          : "用户刚才操作过浏览器 / The user just used the browser",
      );
    }
    if (described) {
      // Recorded as "post": the step thumbnail is follow-up work, not the page action itself.
      const endPost = runtime.timing?.(prepared.call.id)?.enter("post");
      try {
        await step("done", result.image ?? (await picture(result.page)), result.page);
      } finally {
        endPost?.();
      }
    }
    return {
      text: [result.text, ...notes].join("\n"),
      ...(result.image ? { images: [result.image] } : {}),
    };
  } catch (error) {
    let text = hostError(error);
    if (!text) throw error;
    if (error instanceof RpcError) {
      if (error.message === "browser_takeover") browser.stopRetries("takeover");
      if (
        (error.message === "browser_screenshot_unavailable" ||
          error.message === "browser_screenshot_frame_timeout") &&
        input.tool === "browser_screenshot"
      ) {
        browser.stopRetries("screenshot");
        text = browser.retryBoundary("browser_screenshot") ?? text;
      }
      if (
        error.message === "browser_pages_closed_open_again" ||
        error.message === "browser_tab_closed_by_user"
      )
        browser.forgetPage();
    }
    await step(
      error instanceof RpcError && error.message === "browser_reveal_field" ? "denied" : "error",
    );
    const errorCode = hostErrorCode(error);
    return { text, isError: true, ...(errorCode ? { details: { errorCode } } : {}) };
  }
}

function withoutQuery(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? `${parsed.origin}${parsed.pathname}`
      : parsed.protocol;
  } catch {
    return undefined;
  }
}
