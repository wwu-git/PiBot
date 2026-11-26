// Assembles the Simplified Chinese strings for the shared interface.
import { botBrowserZh, browserDebugZh } from "@pibot/browser-contract/i18n";
import {
  computerGuardZh,
  computerHandoffZh,
  computerUseZh,
} from "@pibot/computer-use-contract/i18n";
import { credentialsZh, secretZh } from "@pibot/credentials-contract/i18n";
import { externalAgentsZh } from "@pibot/external-agents-contract/i18n";
import { mediaZh } from "@pibot/images-contract/i18n";
import { providersZh } from "@pibot/models-contract/i18n";
import { officeZh } from "@pibot/office-contract/i18n";
import {
  connectionDrawerZh,
  connectionsZh,
  connectorsZh,
  knowledgeZh,
} from "@pibot/plugins-contract/i18n";
import { remoteZh } from "@pibot/remote-contract/i18n";
import { routineProposalsZh, routinesZh } from "@pibot/routines-contract/i18n";
import { skillsZh, teachZh, workflowsZh } from "@pibot/skills-contract/i18n";
import { builtinZh, piManagerZh, teamsZh } from "@pibot/teams-contract/i18n";
import { changesZh, managedResourcesZh } from "@pibot/workspaces-contract/i18n";
import { mergeTranslations } from "./merge-translations.ts";
import { activityZh } from "./sections/activity.ts";
import { agentReviewZh } from "./sections/agent-review.ts";
import { agentWorkZh } from "./sections/agent-work.ts";
import { appMenuZh } from "./sections/app-menu.ts";
import { autoCheckZh } from "./sections/auto-check.ts";
import { backgroundZh } from "./sections/background.ts";
import { backgroundRecordsZh } from "./sections/background-records.ts";
import { botHooksZh } from "./sections/bot-hooks.ts";
import { capabilitiesZh } from "./sections/capabilities.ts";
import { chatZh } from "./sections/chat.ts";
import { commandAccessZh } from "./sections/command-access.ts";
import { conversationImportZh } from "./sections/conversation-import.ts";
import { draftsZh } from "./sections/drafts.ts";
import { executionZh } from "./sections/execution.ts";
import { filePreviewZh } from "./sections/file-preview.ts";
import { foldersZh } from "./sections/folders.ts";
import { groupZh } from "./sections/group.ts";
import { independentBackgroundZh } from "./sections/independent-background.ts";
import { linuxStartupZh } from "./sections/linux-startup.ts";
import { liveIslandZh } from "./sections/live-island.ts";
import { memorySettingsZh } from "./sections/memory-settings.ts";
import { messageActionsZh } from "./sections/message-actions.ts";
import { networkZh } from "./sections/network.ts";
import { panelsZh } from "./sections/panels.ts";
import { permissionsZh } from "./sections/permissions.ts";
import { personalTodosZh } from "./sections/personal-todos.ts";
import { policyExplanationZh } from "./sections/policy-explanation.ts";
import { providerAuthZh } from "./sections/provider-auth.ts";
import { providerImportZh } from "./sections/provider-import.ts";
import { receiptZh } from "./sections/receipt.ts";
import { runtimeZh } from "./sections/runtime.ts";
import { settingsPagesZh } from "./sections/settings-pages.ts";
import { setupZh } from "./sections/setup.ts";
import { toolFoldZh } from "./sections/tool-fold.ts";
import { toolNamesZh } from "./sections/tool-names.ts";
import { topicWorkplaceZh } from "./sections/topic-workplace.ts";
import { workspaceZh } from "./sections/workspace.ts";
import { yoloZh } from "./sections/yolo.ts";

const common = {
  "app.name": "Pi Bot",
  "common.back": "上一步",
  "common.continue": "继续",
  "common.getStarted": "开始使用",
  "common.skip": "跳过",
  "common.cancel": "取消",
  "common.save": "保存",
  "common.delete": "删除",
  "common.replace": "替换",
  "common.retry": "重试",
  "common.loading": "加载中…",
  "common.search": "搜索",
  "combobox.searchPlaceholder": "输入名称或 ID 搜索…",
  "combobox.searchCategories": "搜索分类",
  "combobox.noResults": "没有匹配的选项",
  "combobox.moreResults": "还有 {count} 项，请继续输入以缩小范围",
  "datePicker.placeholder.date": "选择日期",
  "datePicker.placeholder.datetime": "选择日期和时间",
  "datePicker.placeholder.time": "选择时间",
  "datePicker.previousMonth": "上个月",
  "datePicker.nextMonth": "下个月",
  "datePicker.today": "今天",
  "datePicker.tomorrow": "明天",
  "datePicker.nextMonday": "下周一",
  "datePicker.clear": "清除",
  "datePicker.time": "时间（24 小时制）",
  "datePicker.hour": "小时",
  "datePicker.minute": "分钟",
  "common.optional": "可选",
  "common.comingSoon": "即将支持",
  "common.unsupported": "此平台暂不支持",
  "language.label": "语言",
  "language.zh": "中文",
  "language.en": "English",
  "language.system": "跟随系统",
  "language.note": "只改菜单和按钮的语言。Bot 用什么语言回答，看你怎么跟它说话。",
  "theme.label": "外观",
  "theme.light": "浅色",
  "theme.dark": "深色",
  "theme.system": "跟随系统",
  "theme.preview": "{theme}外观预览",
  "chatFont.label": "对话字号",
  "chatFont.small": "小",
  "chatFont.medium": "中",
  "chatFont.large": "大",
  "welcome.title": "认识一下 Pi Bot",
  "welcome.subtitle": "你的 Bot 团队，在你自己的电脑上干活",
  "welcome.progress": "第 {step} 步，共 {total} 步",
  "welcome.value.team.title": "一群 Bot 帮你干活",
  "welcome.value.team.body": "先和 Pi 聊起来；之后可以在侧栏新建更多 Bot、拉群聊，让它们分工干活。",
  "welcome.value.local.title": "在你自己的电脑上",
  "welcome.value.local.body": "聊天记录和设置留在本机。使用在线模型时，消息会发送给你选择的厂商。",
  "welcome.value.approval.title": "要动手时先问你",
  "welcome.value.approval.body":
    "列目录、读写文件、运行命令和读网页时按权限设置处理，需要时会先问你。",
  "welcome.model.title": "Pi 用哪个模型",
  "welcome.model.subtitle": "之后可以在设置里更换。",
  "welcome.model.route": "模型来源",
  "welcome.model.recommended": "推荐 · OpenRouter",
  "welcome.model.deepseek": "DeepSeek",
  "welcome.model.deepseekShort": "官方 API，便宜、会用工具，已选好 DeepSeek V4.1 Flash。",
  "welcome.model.deepseekPrivacy": "消息直接发给 DeepSeek，不经过中转。",
  "welcome.model.deepseekGetKey": "去 DeepSeek 获取 API Key",
  "welcome.model.openrouter": "OpenRouter",
  "welcome.model.recommendedTag": "推荐",
  "welcome.model.recommendedNote": "一个 Key 用很多模型，已经选好一个便宜、会用工具的模型。",
  "welcome.model.recommendedPrivacy":
    "OpenRouter 也有免费模型。消息会先发给 OpenRouter，再转给模型厂商。",
  "welcome.model.getKey": "去 OpenRouter 获取 API Key",
  "welcome.model.recommendedModel": "模型：{name}",
  "welcome.model.changeModel": "换模型",
  "welcome.model.local": "本地 · Ollama",
  "welcome.model.localNote": "完全离线：在这台电脑上运行，对话不离开这台电脑。",
  "welcome.model.apiKey": "用我的 API Key",
  "welcome.model.apiKeyNote": "连接你选择的模型厂商，按该厂商的用量计费。",
  "welcome.model.openrouterShort": "一个 Key 用很多模型，已选好便宜、会用工具的模型。",
  "welcome.model.chatgptNote": "用你的 ChatGPT 计划额度，不需要 API Key。",
  "welcome.model.apiKeyShort": "API Key、云端凭据或自定义地址。",
  "welcome.model.chatgptBody":
    "用你的 ChatGPT 计划运行 OpenAI 模型：在 OpenAI 的页面上登录，对话直接发给 OpenAI，计入你的计划用量；登录令牌只加密保存在这台电脑。",
  "welcome.model.chatgptPlans": "支持的计划",
  "welcome.model.plan.go": "Go",
  "welcome.model.plan.plus": "Plus",
  "welcome.model.plan.pro": "Pro",
  "welcome.model.plan.business": "Business",
  "welcome.model.proxyToggle": "需要代理？设置网络代理",
  "welcome.model.proxyFromError": "设置网络代理",
  "welcome.model.proxyHint": "在部分地区访问 Google、OpenAI 等模型服务需要代理。",
  "welcome.model.chatgptAfter":
    "登录后在这里选模型；之后也可以在 设置 › 模型与密钥 › 订阅 › ChatGPT 计划 里更换或断开。",
  "welcome.model.detecting": "正在检测 Ollama…",
  "welcome.model.detected": "已检测到 Ollama · {count} 个模型",
  "welcome.model.notDetected": "没有检测到 Ollama",
  "welcome.model.installOllama": "查看 Ollama 安装说明",
  "welcome.model.noLocalModels": "Ollama 正在运行，但还没有模型。请先下载一个模型。",
  "welcome.model.detectAgain": "重新检测",
  "welcome.computer.title": "系统权限",
  "welcome.computer.body": "让 Bot 能操作电脑上的应用；每次操作仍按权限设置确认。",
  "welcome.computer.later": "稍后再说",
  "welcome.computer.restartHint": "开启屏幕录制后，如果仍未生效，请重启 Pi Bot。",
  "welcome.computer.restart": "重启 Pi Bot",
  "welcome.computer.restartFailed": "没能重启 Pi Bot，请完全退出后重新打开。",
  "welcome.pi.title": "认识你的主 Bot",
  "welcome.pi.subtitle":
    "Pi 是你的主 Bot。先聊聊你的想法；之后可以在侧栏新建更多 Bot、拉群聊或设置例行任务。",
  "welcome.pi.hello":
    "你好，我是 Pi。告诉我你想做什么，我们可以一起梳理思路、起草文字或讨论问题。我可以在工作位置里读写文件、运行命令，也可以读网页；需要时会先征求你的同意。",
  "welcome.pi.chat": "和 Pi 聊聊",
  "suggestion.plan": "帮我规划今天的工作",
  "suggestion.write": "帮我起草一封邮件",
  "suggestion.learn": "用简单的话解释一个概念",
  "suggestion.brainstorm": "和我一起想几个点子",
  "sidebar.chats": "会话",
  "sidebar.mainBot": "主 Bot",
  "sidebar.piLabel": "Pi · 你的主 Bot",
  "sidebar.settings": "设置",
  "startup.cached": "上次的界面（只读缓存）",
  "startup.connecting": "正在连接后台…",
  "startup.connectingPhase": "正在连接后台…（{step}）",
  "startup.startingPhase": "正在启动…（{step}）",
  "startup.step.recovery": "恢复数据",
  "startup.step.network": "准备网络",
  "startup.step.capabilities": "准备功能",
  "startup.step.services": "准备各项服务",
  "startup.refreshing": "正在更新界面…",
  "startup.readonly": "连接完成前无法发送、审批或修改设置。缓存不代表已发送。",
  "startup.clearFailed": "界面缓存未能清除，旧预览可能仍在磁盘上。请重试；运行历史尚未清理。",
  "startup.newerData":
    "此数据由更新版本的 Pi Bot 创建，当前版本无法打开。请升级 Pi Bot 后重试；不要删除数据。",
  "startup.clear": "清除界面缓存",
  "startup.clearNote": "移除本机保存的侧栏和最近消息预览，本次退出前不再保存。",
  "brain.starting": "后台服务启动中…",
  "brain.ready": "后台服务已就绪",
  "brain.restarting": "后台服务重启中…",
  "brain.failed": "后台服务无法启动。请导出日志，联系开发者。",
  "chat.hello": "你好，我是 {name}",
  "chat.empty": "告诉我你的想法，我们一起开始。",
  "chat.placeholder": "给 {name} 发消息…",
  "chat.send": "发送",
  "chat.stop": "停止生成",
  "chat.generating": "{name} 正在回复…",
  "chat.answeredOnPhone": "电脑离线时在手机上回答",
  "chat.activity.waiting": "等待模型 · {seconds} 秒",
  "chat.activity.preparing": "正在准备 {tool} · 约 {characters} 字 · {seconds} 秒",
  "chat.activity.executing": "正在执行 {tool} · {seconds} 秒",
  "chat.activity.generatingImage": "正在生成图片 · {seconds} 秒",
  "chat.stopped": "已停止，保留已生成的内容。",
  "chat.stoppedEmpty": "已停止。",
  "chat.stoppedPreserved": "保留了已生成的内容。",
  "chat.interrupted": "已中断 ·",
  "chat.resuming": "正在继续…",
  "chat.resumeFailed": "无法继续。请刷新后确认这次运行是否仍可恢复。",
  "chat.resumeUncertain": "继续请求可能已经送达。请先刷新确认，避免重复启动。",
  "chat.inputHint": "Enter 发送，Shift+Enter 换行，首/末行 ↑/↓ 选择历史输入",
  "chat.noModel": "还没有可用的模型",
  "chat.goToSettings": "去设置",
  "chat.checkKey": "检查 Key",
  "chat.loadEarlier": "加载更早的消息",
  "chat.loadingHistory": "正在加载聊天记录…",
  "chat.historyError": "聊天记录加载失败，请重试。",
  "chat.noMoreHistory": "已显示全部聊天记录",
  "chat.you": "你",
  "chat.model": "当前模型：{model}",
  "chat.thinking": "思考：{level}",
  "chat.busy": "{name} 还在回复上一条消息，请等待或停止生成。",
  "settings.title": "设置",
  "settings.general": "通用",
  "settings.models": "模型与密钥",
  "settings.browser": "浏览器",
  "settings.browserSection": "浏览器",
  "settings.browserDefault": "默认浏览器",
  "settings.browserUnknown": "未知",
  "settings.browserExtension": "Pi Bot 插件",
  "settings.browserExtensionStatus.connected": "已连接",
  "settings.browserExtensionStatus.installed": "未连接（以前连接过）",
  "settings.browserExtensionStatus.edgeNotListed": "尚未在 Microsoft Edge 加载项商店上架",
  "settings.browserExtensionStatus.not_installed": "未安装",
  "settings.browserExtensionStatus.unsupported": "不支持",
  "settings.browserExtensionStatus.separate_data_dir":
    "这个 Pi Bot 使用单独的数据目录，没有接管浏览器扩展。点「在这里连接」后，扩展改为连接这里，主程序会连不上扩展，直到这里退出。",
  "settings.browserExtensionStatus.other_instance":
    "浏览器扩展已连接到另一个 Pi Bot。点「在这里连接」可改为连接这里。",
  "settings.browserExtensionConnectHere": "在这里连接",
  "settings.browserPreference": "使用方式",
  "settings.browserPreferenceUser": "优先用你的浏览器（用你的登录）",
  "settings.browserPreferenceBot": "只用 Pi Bot 自带的 Bot 浏览器",
  "settings.startup": "启动",
  "settings.openAtLogin": "登录时启动",
  "settings.openAtLoginNote": "登录这台电脑后自动启动 Pi Bot。",
  "settings.showTrayIcon": "显示托盘图标",
  "settings.showTrayIconNote":
    "关闭窗口后 Pi Bot 继续在后台运行，可以从托盘或菜单栏打开；要完全退出，用托盘菜单里的「完全退出」。",
  "settings.about": "关于",
  "settings.exportLogs": "导出日志",
  "settings.exportLogsNote":
    "导出包包含脱敏日志、版本与系统语言/时区、连接与已观察的权限状态、最近50次运行和200次工具调用的状态/错误码/耗时。没有聊天正文、文件内容、联系人资料或密钥，不会自动上传。未观察到的权限标为未知。",
  "settings.exportingLogs": "正在导出日志…",
  "settings.logsExported": "日志已导出",
  "settings.logsExportError": "日志导出失败，请重试。",
  "settings.data": "数据与存储",
  "settings.runCleanup": "清理旧运行记录",
  "settings.runCleanupNote":
    "清理指定天数以前的运行事件、结果文件、会话文件和执行登记；聊天内容保留，操作审计仍保留 90 天。",
  "settings.runCleanupDays": "天数",
  "settings.backgroundCommands": "后台命令",
  "settings.backgroundLimit": "总时长上限",
  "settings.backgroundLimitNote":
    "默认 120 分钟，从命令启动时计算，转入后台不重新计时。修改后立即应用到正在运行的后台命令。",
  "settings.backgroundMinutes": "分钟",
  "settings.backgroundLimitInvalid": "请输入 30–1440 之间的整数",
  "settings.backgroundLimitSave": "保存",
  "settings.runCleanupAction": "清理",
  "settings.runCleanupConfirm": "确认清理",
  "settings.runCleaning": "正在清理…",
  "settings.runCleanupInvalid": "请输入 1 到 36500 之间的整数天数。",
  "settings.runCleanupError": "运行记录清理失败；未完成的文件清理会在下次启动时重试。",
  "settings.runCleanupDone":
    "已清理 {runs} 条运行、{events} 条事件、{executions} 条执行登记和 {files} 个文件。",
  "audit.runRetention.cleaned":
    "清理 {days} 天前的运行记录：{runs} 条运行、{events} 条事件、{executions} 条执行登记、{files} 个文件",
  "audit.commandLogs.requested": "按保留设置清理命令日志（{count} 个）",
  "audit.commandLogs.deleted": "已按保留设置删除 {count} 个命令日志（{bytes} 字节）",
  "audit.runRetention.requested": "请求清理 {days} 天前的运行记录",
  "settings.saveError": "设置保存失败，请重试。",
  "errors.import_format_chatgpt": "无法识别 ChatGPT 导出文件的格式。",
  "errors.import_format_claude": "无法识别 Claude 导出文件的格式。",
  "errors.no_model": "还没有可用的模型。请先在设置里配置厂商并为这个 Bot 选择模型。",
  "errors.subscription_unsupported": "订阅登录暂不支持，请改用 API Key。",
  "errors.claude_subscription_unsupported": "Claude 订阅登录已停止支持，请改用 API Key。",
  "errors.chatgpt_reconnect_required": "订阅登录暂不支持，请改用 API Key。",
  "errors.openai_approval_required": "需要 OpenAI 批准，暂不可用。你仍可使用 OpenAI API Key。",
  "errors.chatgpt_plan_denied":
    "ChatGPT 计划拒绝了这次请求：登录已失效，或这个计划不能用这个模型。请在 设置 › 模型与密钥 › 订阅 › ChatGPT 计划 重新登录，或换一个模型。",
  "errors.chatgpt_plan_not_eligible":
    "OpenAI 说这个 ChatGPT 账号现在不能把套餐用在其他应用里（账号、工作区或政策限制）。重新登录不会改变这一点。可以在 设置 › 模型与密钥 › 订阅 改用「ChatGPT（Codex 登录）」，或换一个模型、改用 OpenAI API Key。",
  "errors.auth_failed": "认证失败。请检查 API Key 是否正确、有效，以及是否有权使用这个模型。",
  "errors.billing": "账户余额不足或没有付费额度，请到厂商网站充值后重试。",
  "errors.network":
    "无法连接模型服务。请检查网络（部分地区访问 Google、OpenAI 等需要在设置里配置网络代理）或本机服务是否正在运行，然后重试。",
  "errors.rate_limited": "请求过于频繁，模型服务暂时限制了请求。请稍后重试。",
  "errors.provider_error": "模型厂商暂时无法完成请求。请稍后重试。",
  "errors.provider_overloaded": "模型厂商当前过载或暂时不可用。稍后重试，或换一个模型。",
  "errors.provider_rejected":
    "模型厂商拒绝了这次请求（模型名或参数不被支持）。直接重试不会成功，请换一个模型或检查模型设置。",
  "errors.aborted": "回复已停止，已生成的内容会保留。",
  "errors.internal": "出现了内部错误。请重试；如果仍然失败，请导出日志联系开发者。",
  "tray.open": "打开 Pi Bot",
  "tray.quit": "退出",
  "tray.backgroundTitle": "Pi Bot 仍在后台运行",
  "tray.backgroundBody": "可以从托盘打开 Pi Bot。要完全退出，请使用托盘菜单中的「完全退出」。",
} as const;

export const zhSections = {
  linuxStartup: linuxStartupZh,
  memorySettingsZh,
  toolNamesZh,
  topicFolderAudit: {
    "audit.topicFolderAdded": "话题追加可写文件夹",
    "audit.topicFolderRemoved": "话题移除可写文件夹",
    "audit.topicFolderMoved": "话题工作文件夹换到执行端「{name}」的 {folder}",
    "audit.topicFolderMoveDeclined": "拒绝把话题换到执行端「{name}」的 {folder}",
    "audit.outputsMigrated": "旧产出移到 .pibot/out：{moved} 项，{skipped} 项因同名留在原处",
  },
  policyExplanationZh,
  providersZh,
  remoteZh,
  appMenuZh,
  officeZh,
  filePreviewZh,
  messageActionsZh,
  draftsZh,
  connectorsZh,
  knowledgeZh,
  connectionsZh,
  connectionDrawerZh,
  browserDebugZh,
  executionZh,
  personalTodosZh,
  agentWorkZh,
  agentReviewZh,
  managedResourcesZh,
  commandAccessZh,
  conversationImportZh,
  panelsZh,
  topicWorkplaceZh,
  yoloZh,
  autoCheckZh,
  botHooksZh,
  foldersZh,
  independentBackgroundZh,
  toolFoldZh,
  mediaZh,
  externalAgentsZh,
  routineProposalsZh,
  routinesZh,
  runtimeZh,
  networkZh,
  groupZh,
  teamsZh,
  piManagerZh,
  builtinZh,
  activityZh,
  providerAuthZh,
  providerImportZh,
  receiptZh,
  computerGuardZh,
  backgroundZh,
  backgroundRecordsZh,
  common,
  permissionsZh,
  chatZh,
  capabilitiesZh,
  setupZh,
  workspaceZh,
  botBrowserZh,
  teachZh,
  computerUseZh,
  computerHandoffZh,
  skillsZh,
  workflowsZh,
  changesZh,
  credentialsZh,
  secretZh,
  settingsPagesZh,
  liveIslandZh,
} as const;

export const zh = mergeTranslations(zhSections);

export type TranslationKey = keyof typeof zh;
export type TranslationTable = { [K in TranslationKey]: string };
