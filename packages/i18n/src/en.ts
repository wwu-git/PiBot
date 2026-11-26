// Assembles the English strings for the shared interface.
import { botBrowserEn, browserDebugEn } from "@pibot/browser-contract/i18n";
import {
  computerGuardEn,
  computerHandoffEn,
  computerUseEn,
} from "@pibot/computer-use-contract/i18n";
import { credentialsEn, secretEn } from "@pibot/credentials-contract/i18n";
import { externalAgentsEn } from "@pibot/external-agents-contract/i18n";
import { mediaEn } from "@pibot/images-contract/i18n";
import { providersEn } from "@pibot/models-contract/i18n";
import { officeEn } from "@pibot/office-contract/i18n";
import {
  connectionDrawerEn,
  connectionsEn,
  connectorsEn,
  knowledgeEn,
} from "@pibot/plugins-contract/i18n";
import { remoteEn } from "@pibot/remote-contract/i18n";
import { routineProposalsEn, routinesEn } from "@pibot/routines-contract/i18n";
import { skillsEn, teachEn, workflowsEn } from "@pibot/skills-contract/i18n";
import { builtinEn, piManagerEn, teamsEn } from "@pibot/teams-contract/i18n";
import { changesEn, managedResourcesEn } from "@pibot/workspaces-contract/i18n";
import { mergeTranslations } from "./merge-translations.ts";
import { activityEn } from "./sections/activity.ts";
import { agentReviewEn } from "./sections/agent-review.ts";
import { agentWorkEn } from "./sections/agent-work.ts";
import { appMenuEn } from "./sections/app-menu.ts";
import { autoCheckEn } from "./sections/auto-check.ts";
import { backgroundEn } from "./sections/background.ts";
import { backgroundRecordsEn } from "./sections/background-records.ts";
import { botHooksEn } from "./sections/bot-hooks.ts";
import { capabilitiesEn } from "./sections/capabilities.ts";
import { chatEn } from "./sections/chat.ts";
import { commandAccessEn } from "./sections/command-access.ts";
import { conversationImportEn } from "./sections/conversation-import.ts";
import { draftsEn } from "./sections/drafts.ts";
import { executionEn } from "./sections/execution.ts";
import { filePreviewEn } from "./sections/file-preview.ts";
import { foldersEn } from "./sections/folders.ts";
import { groupEn } from "./sections/group.ts";
import { independentBackgroundEn } from "./sections/independent-background.ts";
import { linuxStartupEn } from "./sections/linux-startup.ts";
import { liveIslandEn } from "./sections/live-island.ts";
import { memorySettingsEn } from "./sections/memory-settings.ts";
import { messageActionsEn } from "./sections/message-actions.ts";
import { networkEn } from "./sections/network.ts";
import { panelsEn } from "./sections/panels.ts";
import { permissionsEn } from "./sections/permissions.ts";
import { personalTodosEn } from "./sections/personal-todos.ts";
import { policyExplanationEn } from "./sections/policy-explanation.ts";
import { providerAuthEn } from "./sections/provider-auth.ts";
import { providerImportEn } from "./sections/provider-import.ts";
import { receiptEn } from "./sections/receipt.ts";
import { runtimeEn } from "./sections/runtime.ts";
import { settingsPagesEn } from "./sections/settings-pages.ts";
import { setupEn } from "./sections/setup.ts";
import { toolFoldEn } from "./sections/tool-fold.ts";
import { toolNamesEn } from "./sections/tool-names.ts";
import { topicWorkplaceEn } from "./sections/topic-workplace.ts";
import { workspaceEn } from "./sections/workspace.ts";
import { yoloEn } from "./sections/yolo.ts";
import type { TranslationTable } from "./zh.ts";

const common = {
  "app.name": "Pi Bot",
  "common.back": "Back",
  "common.continue": "Continue",
  "common.getStarted": "Get started",
  "common.skip": "Skip",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.replace": "Replace",
  "common.retry": "Retry",
  "common.loading": "Loading…",
  "common.search": "Search",
  "combobox.searchPlaceholder": "Search by name or ID…",
  "combobox.searchCategories": "Search categories",
  "combobox.noResults": "No matching options",
  "combobox.moreResults": "{count} more options. Keep typing to narrow the results.",
  "datePicker.placeholder.date": "Pick a date",
  "datePicker.placeholder.datetime": "Pick a date and time",
  "datePicker.placeholder.time": "Pick a time",
  "datePicker.previousMonth": "Previous month",
  "datePicker.nextMonth": "Next month",
  "datePicker.today": "Today",
  "datePicker.tomorrow": "Tomorrow",
  "datePicker.nextMonday": "Next Monday",
  "datePicker.clear": "Clear",
  "datePicker.time": "Time (24-hour)",
  "datePicker.hour": "Hour",
  "datePicker.minute": "Minute",
  "common.optional": "Optional",
  "common.comingSoon": "Coming soon",
  "common.unsupported": "Not yet supported on this platform",
  "language.label": "Language",
  "language.zh": "中文",
  "language.en": "English",
  "language.system": "System",
  "language.note": "Changes menus and buttons only. Bots reply in the language you use.",
  "theme.label": "Appearance",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system": "System",
  "theme.preview": "{theme} appearance preview",
  "chatFont.label": "Chat text size",
  "chatFont.small": "Small",
  "chatFont.medium": "Medium",
  "chatFont.large": "Large",
  "welcome.title": "Meet Pi Bot",
  "welcome.subtitle": "Your bot team, working on your own computer",
  "welcome.progress": "Step {step} of {total}",
  "welcome.value.team.title": "A team of bots",
  "welcome.value.team.body":
    "Start by talking with Pi. Later, create more bots and group chats from the sidebar and let them split the work.",
  "welcome.value.local.title": "On your own computer",
  "welcome.value.local.body":
    "Chat history and settings stay on your computer. When you use an online model, messages go to the provider you choose.",
  "welcome.value.approval.title": "Asks before it acts",
  "welcome.value.approval.body":
    "Folder access, file operations, commands, and webpage requests follow your permission settings and ask when needed.",
  "welcome.model.title": "Which model should Pi use?",
  "welcome.model.subtitle": "You can change this later in Settings.",
  "welcome.model.route": "Model source",
  "welcome.model.recommended": "Recommended · OpenRouter",
  "welcome.model.deepseek": "DeepSeek",
  "welcome.model.deepseekShort":
    "The official API: low cost, good with tools; DeepSeek V4.1 Flash is picked.",
  "welcome.model.deepseekPrivacy": "Messages go straight to DeepSeek, with no relay in between.",
  "welcome.model.deepseekGetKey": "Get an API key at DeepSeek",
  "welcome.model.openrouter": "OpenRouter",
  "welcome.model.recommendedTag": "Recommended",
  "welcome.model.recommendedNote":
    "One key for many models; a low-cost model that handles tools is already picked.",
  "welcome.model.recommendedPrivacy":
    "OpenRouter also has free models. Messages go to OpenRouter, then to the model's vendor.",
  "welcome.model.getKey": "Get an API key at OpenRouter",
  "welcome.model.recommendedModel": "Model: {name}",
  "welcome.model.changeModel": "Change model",
  "welcome.model.local": "Local · Ollama",
  "welcome.model.localNote":
    "Fully offline: runs on this computer and your conversation stays here.",
  "welcome.model.apiKey": "Use my API key",
  "welcome.model.apiKeyNote":
    "Connect to a model provider of your choice. The provider charges for usage.",
  "welcome.model.openrouterShort":
    "One key for many models; a low-cost model that uses tools is picked.",
  "welcome.model.chatgptNote": "Use your ChatGPT plan's allowance, no API key needed.",
  "welcome.model.apiKeyShort": "API key, cloud credentials or a custom URL.",
  "welcome.model.chatgptBody":
    "Run OpenAI models on your ChatGPT plan: you sign in on OpenAI's page, conversations go straight to OpenAI and count toward your plan's usage, and the sign-in token is stored encrypted on this computer only.",
  "welcome.model.chatgptPlans": "Supported plans",
  "welcome.model.plan.go": "Go",
  "welcome.model.plan.plus": "Plus",
  "welcome.model.plan.pro": "Pro",
  "welcome.model.plan.business": "Business",
  "welcome.model.proxyToggle": "Need a proxy? Set up a network proxy",
  "welcome.model.proxyFromError": "Set up a network proxy",
  "welcome.model.proxyHint":
    "In some regions, model services such as Google and OpenAI need a proxy.",
  "welcome.model.chatgptAfter":
    "After signing in, choose a model here. You can change it or disconnect later in Settings › Models & API keys › Subscriptions › ChatGPT plan.",
  "welcome.model.detecting": "Looking for Ollama…",
  "welcome.model.detected": "Found Ollama · models: {count}",
  "welcome.model.notDetected": "Ollama not detected",
  "welcome.model.installOllama": "View Ollama installation instructions",
  "welcome.model.noLocalModels":
    "Ollama is running, but no models are installed. Download a model first.",
  "welcome.model.detectAgain": "Check again",
  "welcome.computer.title": "System permissions",
  "welcome.computer.body":
    "Let bots operate apps on this computer. Each operation still follows your permission settings.",
  "welcome.computer.later": "Not now",
  "welcome.computer.restartHint":
    "If Screen Recording still has not taken effect after you enable it, restart Pi Bot.",
  "welcome.computer.restart": "Restart Pi Bot",
  "welcome.computer.restartFailed": "Couldn’t restart Pi Bot. Fully quit and reopen it.",
  "welcome.pi.title": "Meet your main bot",
  "welcome.pi.subtitle":
    "Pi is your main bot. Start by sharing your ideas. Later you can create more bots, group chats and scheduled tasks from the sidebar.",
  "welcome.pi.hello":
    "Hi, I’m Pi. Tell me what you have in mind. We can organize ideas, draft text, or talk through a problem. I can read and write files in working folders, run commands, and read webpages, asking for your permission when needed.",
  "welcome.pi.chat": "Chat with Pi",
  "suggestion.plan": "Help me plan my workday",
  "suggestion.write": "Help me draft an email",
  "suggestion.learn": "Explain a concept in plain language",
  "suggestion.brainstorm": "Brainstorm some ideas with me",
  "sidebar.chats": "Chats",
  "sidebar.mainBot": "Main bot",
  "sidebar.piLabel": "Pi · your main bot",
  "sidebar.settings": "Settings",
  "startup.cached": "Previous interface (read-only cache)",
  "startup.connecting": "Connecting to the background service…",
  "startup.connectingPhase": "Connecting to the background service… ({step})",
  "startup.startingPhase": "Starting… ({step})",
  "startup.step.recovery": "recovering data",
  "startup.step.network": "preparing the network",
  "startup.step.capabilities": "preparing features",
  "startup.step.services": "preparing services",
  "startup.refreshing": "Updating the interface…",
  "startup.readonly":
    "Sending, approvals and settings are disabled until connected. Cached messages are not send receipts.",
  "startup.clearFailed":
    "The interface cache could not be cleared; old previews may remain on disk. Retry; run history has not been cleaned.",
  "startup.newerData":
    "This data was created by a newer version of Pi Bot and cannot be opened by this version. Update Pi Bot and retry; do not delete the data.",
  "startup.clear": "Clear interface cache",
  "startup.clearNote":
    "Remove locally saved sidebar and recent message previews; pause saving until next launch.",
  "brain.starting": "Starting the background service…",
  "brain.ready": "Background service ready",
  "brain.restarting": "Restarting the background service…",
  "brain.failed":
    "The background service couldn’t start. Export the logs and contact the developer.",
  "chat.hello": "Hi, I’m {name}",
  "chat.empty": "Tell me what you have in mind, and we’ll get started.",
  "chat.placeholder": "Message {name}…",
  "chat.send": "Send",
  "chat.stop": "Stop generating",
  "chat.generating": "{name} is replying…",
  "chat.answeredOnPhone": "Answered on the phone while this computer was offline",
  "chat.activity.waiting": "Waiting for model · {seconds}s",
  "chat.activity.preparing": "Preparing {tool} · about {characters} chars · {seconds}s",
  "chat.activity.executing": "Running {tool} · {seconds}s",
  "chat.activity.generatingImage": "Generating image · {seconds}s",
  "chat.stopped": "Stopped. The text generated so far has been kept.",
  "chat.stoppedEmpty": "Stopped.",
  "chat.stoppedPreserved": "The text generated so far has been kept.",
  "chat.interrupted": "Interrupted ·",
  "chat.resuming": "Continuing…",
  "chat.resumeFailed": "Couldn’t continue. Refresh and check whether this run is still available.",
  "chat.resumeUncertain":
    "The continue request may have arrived. Refresh before trying again so the work is not started twice.",
  "chat.inputHint":
    "Enter to send, Shift+Enter for a new line, ↑/↓ on first/last line for input history",
  "chat.noModel": "No model available yet",
  "chat.goToSettings": "Open Settings",
  "chat.checkKey": "Check API key",
  "chat.loadEarlier": "Load earlier messages",
  "chat.loadingHistory": "Loading chat history…",
  "chat.historyError": "Couldn’t load chat history. Please try again.",
  "chat.noMoreHistory": "You’ve reached the beginning of this chat",
  "chat.you": "You",
  "chat.model": "Current model: {model}",
  "chat.thinking": "Reasoning: {level}",
  "chat.busy": "{name} is still replying to your last message. Wait or stop generating first.",
  "settings.title": "Settings",
  "settings.general": "General",
  "settings.models": "Models & API keys",
  "settings.browser": "Browser",
  "settings.browserSection": "Browser",
  "settings.browserDefault": "Default browser",
  "settings.browserUnknown": "Unknown",
  "settings.browserExtension": "Pi Bot extension",
  "settings.browserExtensionStatus.connected": "Connected",
  "settings.browserExtensionStatus.installed": "Disconnected (previously connected)",
  "settings.browserExtensionStatus.edgeNotListed": "Not yet listed in Microsoft Edge Add-ons",
  "settings.browserExtensionStatus.not_installed": "Not installed",
  "settings.browserExtensionStatus.unsupported": "Unsupported",
  "settings.browserExtensionStatus.separate_data_dir":
    "This Pi Bot uses a separate data folder and has not taken over the browser extension. Choose Connect here to switch the extension to this copy; your main Pi Bot loses it until this copy quits.",
  "settings.browserExtensionStatus.other_instance":
    "The browser extension is connected to another Pi Bot. Choose Connect here to switch it to this one.",
  "settings.browserExtensionConnectHere": "Connect here",
  "settings.browserPreference": "Use browser",
  "settings.browserPreferenceUser": "Prefer your browser (use your sign-in)",
  "settings.browserPreferenceBot": "Use only Pi Bot's built-in Bot browser",
  "settings.startup": "Startup",
  "settings.openAtLogin": "Open at login",
  "settings.openAtLoginNote": "Start Pi Bot automatically when you log in to this computer.",
  "settings.showTrayIcon": "Show tray icon",
  "settings.showTrayIconNote":
    "After you close the window, Pi Bot keeps running in the background; open it from the tray or menu bar. To quit completely, use Quit completely in the tray menu.",
  "settings.about": "About",
  "settings.exportLogs": "Export logs",
  "settings.exportLogsNote":
    "The archive contains redacted logs, version and system language/time zone, connection and observed permission states, and status/error codes/timing for the last 50 runs and 200 tool calls. No chat text, file contents, contact details or secrets. Nothing is uploaded automatically. Unobserved permissions are marked unknown.",
  "settings.exportingLogs": "Exporting logs…",
  "settings.logsExported": "Logs exported",
  "settings.logsExportError": "Couldn’t export logs. Please try again.",
  "settings.data": "Data & storage",
  "settings.runCleanup": "Clean up old run records",
  "settings.runCleanupNote":
    "Removes run events, result files, session files, and execution records older than the selected number of days. Chats stay; audit records still follow the 90-day policy.",
  "settings.runCleanupDays": "Days",
  "settings.backgroundCommands": "Background commands",
  "settings.backgroundLimit": "Total time limit",
  "settings.backgroundLimitNote":
    "Defaults to 120 minutes from command start. Moving to background does not reset it. Changes apply immediately to running background commands.",
  "settings.backgroundMinutes": "Minutes",
  "settings.backgroundLimitInvalid": "Enter a whole number from 30 to 1440",
  "settings.backgroundLimitSave": "Save",
  "settings.runCleanupAction": "Clean up",
  "settings.runCleanupConfirm": "Confirm cleanup",
  "settings.runCleaning": "Cleaning up…",
  "settings.runCleanupInvalid": "Enter a whole number from 1 to 36500 days.",
  "settings.runCleanupError":
    "Run cleanup failed. Any unfinished file cleanup will be retried on the next start.",
  "settings.runCleanupDone":
    "Cleaned {runs} runs, {events} events, {executions} execution records, and {files} files.",
  "audit.runRetention.cleaned":
    "Cleaned run records older than {days} days: {runs} runs, {events} events, {executions} execution records, and {files} files",
  "audit.commandLogs.requested": "Requested command log retention cleanup ({count} files)",
  "audit.commandLogs.deleted":
    "Deleted {count} command logs under retention settings ({bytes} bytes)",
  "audit.runRetention.requested": "Requested cleanup of run records older than {days} days",
  "settings.saveError": "Couldn’t save settings. Please try again.",
  "errors.import_format_chatgpt": "The ChatGPT export format was not recognized.",
  "errors.import_format_claude": "The Claude export format was not recognized.",
  "errors.no_model":
    "No model is available. Configure a provider in Settings and choose a model for this Bot first.",
  "errors.subscription_unsupported":
    "Subscription sign-in is temporarily unavailable. Use an API key instead.",
  "errors.claude_subscription_unsupported":
    "Claude subscription sign-in is no longer supported. Use an API key instead.",
  "errors.chatgpt_reconnect_required":
    "Subscription sign-in is temporarily unavailable. Use an API key instead.",
  "errors.openai_approval_required":
    "OpenAI approval is required. Sign-in is currently unavailable. You can still use an OpenAI API key.",
  "errors.chatgpt_plan_denied":
    "The ChatGPT plan refused this request: the sign-in has expired, or the plan can't use this model. Sign in again in Settings › Models & API keys › Subscriptions › ChatGPT plan, or pick another model.",
  "errors.chatgpt_plan_not_eligible":
    "OpenAI says this ChatGPT account can't use its plan in other apps right now (an account, workspace or policy restriction). Signing in again won't change that. Switch to \"ChatGPT (Codex sign-in)\" in Settings › Models & API keys › Subscriptions, or pick another model or an OpenAI API key.",
  "errors.auth_failed":
    "Authentication failed. Check that your API key is correct, still valid, and has access to this model.",
  "errors.billing":
    "Your account has insufficient credit or no paid quota. Top up with the provider and try again.",
  "errors.network":
    "Couldn’t connect to the model service. Check your network (in some regions Google, OpenAI and others need a network proxy, set in Settings) or make sure the local service is running, then try again.",
  "errors.rate_limited":
    "The model service is temporarily rate limiting requests. Please try again later.",
  "errors.provider_error":
    "The model provider couldn’t complete this request. Please try again later.",
  "errors.provider_overloaded":
    "The model provider is overloaded or temporarily unavailable. Try again later or switch to another model.",
  "errors.provider_rejected":
    "The model provider rejected this request (model name or parameters not supported). Retrying won’t help — switch models or check the model settings.",
  "errors.aborted": "The reply was stopped. The text generated so far has been kept.",
  "errors.internal":
    "Something went wrong internally. Try again. If the problem continues, export the logs and contact the developer.",
  "tray.open": "Open Pi Bot",
  "tray.quit": "Quit",
  "tray.backgroundTitle": "Pi Bot is still running in the background",
  "tray.backgroundBody":
    "Open Pi Bot from the tray. To exit completely, choose Quit completely from the tray menu.",
} as const;

export const enSections = {
  linuxStartup: linuxStartupEn,
  memorySettingsEn,
  toolNamesEn,
  topicFolderAudit: {
    "audit.topicFolderAdded": "Writable folder added to topic",
    "audit.topicFolderRemoved": "Writable folder removed from topic",
    "audit.topicFolderMoved": 'Topic moved to {folder} on runner "{name}"',
    "audit.topicFolderMoveDeclined": 'Declined moving the topic to {folder} on runner "{name}"',
    "audit.outputsMigrated":
      "Old outputs moved to .pibot/out: {moved} moved, {skipped} left in place (name taken)",
  },
  policyExplanationEn,
  providersEn,
  remoteEn,
  appMenuEn,
  officeEn,
  filePreviewEn,
  messageActionsEn,
  draftsEn,
  connectorsEn,
  knowledgeEn,
  connectionsEn,
  connectionDrawerEn,
  browserDebugEn,
  executionEn,
  personalTodosEn,
  agentWorkEn,
  agentReviewEn,
  managedResourcesEn,
  commandAccessEn,
  conversationImportEn,
  panelsEn,
  topicWorkplaceEn,
  yoloEn,
  autoCheckEn,
  botHooksEn,
  foldersEn,
  independentBackgroundEn,
  toolFoldEn,
  mediaEn,
  externalAgentsEn,
  routineProposalsEn,
  routinesEn,
  runtimeEn,
  networkEn,
  groupEn,
  teamsEn,
  piManagerEn,
  builtinEn,
  activityEn,
  providerAuthEn,
  providerImportEn,
  receiptEn,
  computerGuardEn,
  backgroundEn,
  backgroundRecordsEn,
  common,
  permissionsEn,
  chatEn,
  capabilitiesEn,
  setupEn,
  workspaceEn,
  botBrowserEn,
  teachEn,
  computerUseEn,
  computerHandoffEn,
  skillsEn,
  workflowsEn,
  changesEn,
  credentialsEn,
  secretEn,
  settingsPagesEn,
  liveIslandEn,
} as const;

export const en = mergeTranslations(enSections) satisfies TranslationTable;
