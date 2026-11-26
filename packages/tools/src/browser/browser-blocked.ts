import {
  type BrowserBlocked,
  type BrowserBlockedReason,
  privateNetworkOrigin,
} from "@pibot/protocol-base";
import type { BrowserToolPort, ToolCallView } from "../runtime/tool-runtime.ts";
import { safeHost } from "./browser-actions.ts";

export function blockedReasonNote(reason: BrowserBlockedReason, googleCompat = false) {
  switch (reason) {
    case "google_embedded_signin":
      if (!googleCompat)
        return "Google 不允许在内嵌浏览器（包括 Bot 浏览器）里登录 Google 账号，这和账号、密码无关，重试也没有用。不要再尝试登录，请告诉用户：可以在这个 Bot 资料面板的「权限与连接」里打开「Google 兼容模式」（或点浏览器侧栏提示里的按钮），然后再接管登录。 / Google does not allow signing in to a Google account from embedded browsers, including the Bot browser. This is not about the account or the password, and retrying will not help. Stop trying to sign in and tell the user they can turn on Google compatibility mode in this Bot's Permissions & connections (or with the button in the browser pane's notice), then take over to sign in.";
      return "Google 不允许在内嵌浏览器（包括 Bot 浏览器）里登录 Google 账号，这和账号、密码无关，重试也没有用。不要再尝试登录，请告诉用户：以后可以通过 Pi Bot 的官方 Google 连接来使用 Google 服务；如果是要登录别的网站，请改用该网站自己的账号密码等其他方式登录。 / Google does not allow signing in to a Google account from embedded browsers, including the Bot browser. This is not about the account or the password, and retrying will not help. Stop trying to sign in and tell the user: Google services can be used later through Pi Bot's official Google connection; for another site, sign in there another way (for example that site's own account and password).";
  }
}

export function blockedNote(entry: BrowserBlocked) {
  const where = entry.domain ?? safeHost(entry.url);
  switch (entry.kind) {
    case "private":
      return `已拦截本机或内网地址 ${where} / Blocked a local or private address ${where}`;
    case "not_listed":
      return `${where} 不在只允许访问的网站列表里，需要用户在设置里添加 / ${where} is not in the allowed site list; the user can add it in settings`;
    case "upload":
      return `网页想上传文件，Bot 浏览器暂不支持 / The page asked for a file upload, which the Bot browser does not support yet`;
    case "download":
      return `下载被拦截 / A download was blocked (${where})`;
    case "submit":
      return `没有获准在 ${where} 提交表单 / Form submission on ${where} was not allowed`;
    default:
      return `没有获准访问 ${where} / Visiting ${where} was not allowed`;
  }
}

export async function handleBlocked(
  browser: BrowserToolPort,
  call: ToolCallView,
  blocked: BrowserBlocked[],
  writeRoot: string | undefined,
  signal: AbortSignal,
): Promise<{ approved: boolean; notes: string[] }> {
  const notes: string[] = [];
  let approved = false;
  const seen = new Set<string>();
  for (const entry of blocked) {
    // Private consent is per origin, including port and scheme, rather than per hostname.
    const target =
      entry.kind === "private"
        ? (privateNetworkOrigin(entry.url) ?? entry.url)
        : (entry.domain ?? safeHost(entry.url));
    const key = `${entry.kind}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const answer = await browser.authorizeBlocked(call, entry, writeRoot, signal);
    if (answer.note) notes.push(`${blockedNote(entry)}: ${answer.note}`);
    else if (!answer.approved) notes.push(blockedNote(entry));
    approved ||= answer.approved;
  }
  return { approved, notes };
}
