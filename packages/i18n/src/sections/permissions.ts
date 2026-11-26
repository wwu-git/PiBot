// Translate permission settings, approvals, and policy warnings.
import { linuxIsolationRemedies } from "@pibot/execution/isolation-remedy";

export const permissionsZh = {
  "permissions.serviceTrust": "证书信任评估",
  "permissions.serviceDirectory": "用户与组查询",
  "permissions.serviceNotification": "系统通知",
  "permissions.serviceOther": "系统服务 {service}",
  "permissions.sandboxRemembered": "沙箱里记住的授权",
  "permissions.sandboxRememberedSummary":
    "{count} 项 · 写入路径 {writes} · 本机服务 {local} · 系统服务 {system}",
  "permissions.sandboxRememberedSummary.one":
    "{count} 项 · 写入路径 {writes} · 本机服务 {local} · 系统服务 {system}",
  "permissions.sandboxWrites": "写入路径",
  "permissions.sandboxLocal": "本机服务",
  "permissions.sandboxSystem": "系统服务",
  "approval.sandboxRemember": "允许，这个文件夹以后不再问",
  "facts.value.system_service": "只放行这一项系统服务。",
  "policy.reason.system_service_once": "允许这个程序使用所列系统服务",

  "policy.reason.git_entry_confirmation_required":
    "这条 Git 命令会运行项目里的钩子或可执行配置（见下），需要你这次明确确认，不记住；YOLO、已有授权和例行任务都不能代答",
  "facts.value.git_entry_once":
    "只允许这一次运行所列入口；只固定了入口文件本身，它再调用的程序没有固定。运行前若任何入口或配置有变化，这次会被拒绝",
  "policy.reason.git_entry_include_unknown":
    "仓库的 Git 配置用了 include / includeIf，无法确认会运行哪些程序，暂不支持",
  "policy.reason.git_entry_layout_unsupported":
    "这个 Git 布局（--git-dir、core.worktree、子模块递归等）里的钩子无法逐项确认，暂不支持",
  "policy.reason.git_entry_scan_incomplete":
    "没能在限额内读完仓库的钩子和配置，无法确认会运行什么，未执行",
  "policy.reason.git_entry_compound":
    "复合命令里的 Git 会运行项目钩子或可执行配置，无法逐次确认；请单独运行这条 Git 命令",
  "policy.reason.git_entry_dynamic":
    "命令用环境变量、-c 或别名改变了仓库、配置或要运行的程序，无法确认会运行什么",
  "policy.reason.git_entry_unsupported_target":
    "这条 Git 命令会运行项目钩子或可执行配置；例行任务、后台、Docker、沙箱外运行、Windows 或无法检查的执行端下不能当场确认，未执行",
  "policy.reason.git_hooks_path_confirmation_required":
    "这次修改项目 Git hooksPath 目录需要你明确确认，不能记住；不会执行或授权任何 hook",
  "facts.value.git_hooks_path_setter":
    "仅修改项目 core.hooksPath，不读取钩子正文、不执行钩子，也不授予后续 Git 入口运行许可",
  "policy.reason.git_inline_execution_unsupported":
    "这条 Git 命令可能调用显式覆盖的可执行配置，暂不支持逐次受控执行；普通权限、YOLO 或已有授权不能代替，不会运行",

  "policy.reason.git_hook_confirmation_required":
    "单次运行所示 pre-commit 原生程序钩子，需要你明确确认，不记住授权",
  "policy.reason.git_hook_unsupported":
    "这个 Git 钩子、脚本形态或执行端暂不支持受控运行，不会改用原始命令执行",
  "policy.reason.git_hook_unverified": "Git 钩子、程序或工作范围与准备版本不一致，未运行",
  "facts.value.git_hook_literal_exec":
    "仅执行默认 pre-commit 钩子的固定系统原生程序及所示字面参数；不含 Node/脚本、联网、凭据或配置修改。仅这次，不记住",
  "policy.reason.host_ssh_not_enabled": "这个 SSH 主机没有打开：设置 → 权限 → 高级 → SSH 主机",
  "policy.reason.host_ssh_identity_required":
    "这个主机还没选私钥，请在 设置 → 权限 → 高级 → SSH 主机 里选",
  "policy.reason.host_ssh_unsupported":
    "暂不支持这个 SSH 形式、配置或执行端；不会开放整个 .ssh 或改用普通命令执行",
  "policy.reason.ssh_config_private": "~/.ssh 是凭据目录，不能读；连接主机请用 ssh 别名 '命令'",
  "policy.reason.host_ssh_unsupported_syntax":
    "这个 SSH 写法暂不支持：只支持 ssh 别名 '远端命令'，加少数安全选项",
  "policy.reason.host_ssh_unsupported_target": "宿主 SSH 目前只支持 macOS 本机的普通聊天",
  "policy.reason.host_ssh_configuration_unavailable": "在 ~/.ssh/config 里找不到这个别名",
  "policy.reason.host_ssh_unsupported_configuration":
    "这个主机的 SSH 配置用了暂不支持的功能，不会删掉后再连接",
  "policy.reason.host_ssh_config_strict_host_key":
    "这个主机把 StrictHostKeyChecking 写成了 yes 以外的值（如 accept-new）；改回 yes 后再试",
  "policy.reason.host_ssh_config_option":
    "这个主机的 SSH 配置里有 Pi Bot 不支持的选项；具体哪一行看 设置 → 权限 → 高级 → SSH 主机",
  "policy.reason.host_ssh_config_user":
    "这个主机没写可用的 User（允许一个 @，如 用户@机器）；补上后再试",
  "policy.reason.host_ssh_config_identity_outside_ssh":
    "这个主机的私钥在 ~/.ssh 之外；把私钥放进 ~/.ssh（权限 600）或改 IdentityFile 后再试",
  "policy.reason.host_ssh_unverified": "SSH 命令、配置或文件版本不匹配，未授予访问权限",
  "facts.value.host_ssh_static_identity":
    "只复用静态别名和一把密钥；不执行用户代理命令或系统配置，不返回 SSH 本地诊断和远端 stderr",
  "policy.reason.git_configuration_confirmation_required":
    "这次受控 Git 配置修改需要你明确确认，不能记住授权",
  "policy.reason.git_configuration_unsupported":
    "这个 Git 配置操作或执行端暂不支持受控修改，不会改用原始命令执行",
  "policy.reason.git_configuration_unverified":
    "Git 配置操作、目标或准备版本不匹配，未授予修改权限",
  "policy.reason.git_configuration_project_setter":
    "仅通过受控操作修改当前项目的一个普通 Git 配置键",
  "policy.reason.git_configuration_global_setter":
    "仅通过受控操作修改当前用户的一项 Git 姓名或邮箱设置",
  "facts.value.git_configuration_project_setter":
    "只改所示项目配置的一个普通键，不授予整份配置或目录的写权限；值不显示",
  "facts.value.git_configuration_global_setter":
    "只改所示用户配置的姓名或邮箱，必须每次确认；不授予目录权限，值不显示",
  "policy.reason.git_configuration_sensitive_project_setter":
    "仅修改当前项目一个可执行 Git 配置键，不会运行其中的程序；以后使用该入口仍须单独确认",
  "facts.value.git_configuration_sensitive_project_setter":
    "只修改所示项目配置的一个可执行键（helper / filter / sshCommand），仅这次、不记住；本次不运行该程序，以后使用仍须另行确认。值不显示，不授予整份配置或目录权限",
  "policy.reason.task_web_read": "你已在本群任务内允许读取公开网页",
  "approval.allowTaskWeb": "本任务内允许读取公开网页",
  "approval.taskWebsiteHint":
    "本群任务或计划的所有成员、重试和改派共用，仅公开网页只读 GET；不含 Bot 浏览器、登录、表单或内网。任务结束、取消、计划完成或重启后失效。",
  "policy.reason.conversation_web_read": "你已在本对话内允许读取这个网站的公开网页",
  "approval.allowConversation": "本对话内允许这个网站",
  "approval.conversationWebsiteHint":
    "仅 {domain} 及其子域名的公开网页只读 GET；不含浏览器、登录、表单或内网。此授权仅本 Bot、本对话有效，重启后失效。",
  "permissions.singleRootScope": "仅工作根 {root}",
  "permissions.topicGrantScope": "话题 {topic} · 当前可写根：{roots}（随话题变更）",
  "permissions.topicGrantUnavailable": "工作范围不可用，执行前重新校验",
  "permissions.topicGrantNoRoots": "无可写根",
  "permissions.yoloUnisolated": "Windows 上 YOLO 自动运行命令",
  "permissions.yoloWindowsConsentedAt":
    "已同意（{date}）。开了 YOLO 的对话里普通命令直接运行，危险命令仍需确认。撤回后下次开启 YOLO 会再次说明。",
  "permissions.yoloWindowsConsented":
    "已同意。开了 YOLO 的对话里普通命令直接运行，危险命令仍需确认。撤回后下次开启 YOLO 会再次说明。",
  "permissions.yoloWindowsNotConsented": "尚未同意。开启 YOLO 时可以确认。",
  "permissions.yoloWindowsWithdraw": "撤回",
  "permissions.yoloWindowsWithdrawFailed": "未能撤回同意，请重试。",
  "permissions.strictSandbox": "严格沙箱",
  "permissions.strictSandboxNote":
    "打开后，命令被沙箱拦截时只说明原因，不提供「在沙箱外运行一次」，下面的清单也不生效。",
  "permissions.sandboxAutoOutside": "自动记住",
  "permissions.sandboxAutoDelete": "删除",
  "permissions.sandboxOutsideCommands": "固定在沙箱外运行的命令",
  "permissions.sandboxOutsideCommandsNote":
    "每行一条：程序名加固定参数，末尾可加 *（例如 docker compose *）。复合命令每一段都匹配才算；含重定向、cd 或变量展开的不匹配。手工条目每次仍需确认；自动条目仅限所列文件夹，按普通权限规则运行。沙箱外没有文件和网络隔离。",
  "permissions.sandboxOutsideCommandsStrict": "严格沙箱已打开，清单暂不生效。",
  "permissions.sandboxOutsideCommandsInvalid":
    "格式不对：每行一条，程序名加参数，* 只能放在最后，最多 32 条。",
  "permissions.unisolated": "未隔离",
  "permissions.note.run_command.windows":
    "Windows 没有命令沙箱。受支持的只读命令（如 dir、type）经权限检查后直接运行。",
  "permissions.info.run_command.windows":
    "设为「不允许」时命令不会运行。经权限检查的受支持只读命令可直接运行。普通命令逐次确认，除非这个对话开了 YOLO 且你同意无隔离执行。",
  "permissions.windowsAlwaysUnavailable":
    "Windows 命令没有系统隔离，不能设为总是允许；YOLO 自动批准需单独开启",
  "permissions.connectionsAndSending": "连接与发送",
  "permissions.confirmEverySend": "这个 Bot 每次对外发送都要你确认",
  "approval.connection": "插件",
  "approval.connectedTool": "本次操作",
  "approval.connectionId": "连接 ID",
  "approval.toolId": "工具 ID",
  "approval.connectorDetails": "连接与工具详情",
  "approval.connectorHint.once": "仅允许本次只读调用，下次使用时再询问。",
  "approval.connectorHint.bot": "允许这个 Bot 使用此连接；工具权限与对外发送确认仍然生效。",
  "approval.connectorHint.all": "允许所有 Bot 使用此连接；工具权限与对外发送确认仍然生效。",
  "approval.connectorAccess": "使用此连接的范围",
  "approval.connectorOnce": "只这一次",
  "approval.connectorBot": "总是允许这个 Bot 使用",
  "approval.connectorAll": "所有 Bot 都可以用",
  "approval.connectorAllow": "允许",

  "log.output": "命令输出",
  "log.search": "搜索输出",
  "log.matches": "第 {current} / 共 {total} 个",
  "log.previous": "上一个",
  "log.next": "下一个",
  "log.wrap": "自动换行",
  "log.copy": "复制全部",
  "log.reveal.mac": "在访达中显示",
  "log.reveal.win": "在资源管理器中显示",
  "log.reveal.linux": "在文件管理器中显示",
  "log.close": "关闭",
  "log.truncated": "只显示前 5 MB",
  "log.empty": "这条命令没有输出",
  "log.missing": "这条命令没有留下输出日志",
  "log.error": "无法读取输出日志。",
  "log.actionError": "操作失败，请重试。",
  "log.unsupported": "此平台不支持在文件管理器中显示。",
  "log.more": "加载更多",

  "permissions.adjust": "调整权限",
  "permissions.scope": "权限范围",
  "permissions.allBots": "全部 Bot",
  "permissions.followGlobal": "跟随全局",
  "permissions.ceiling": "全局默认：{level}；Bot 可独立设置。",
  "permissions.custom": "独立设置",
  "tool.read_messages": "查询聊天历史",
  "audit.messages.read": "已查询 {messages} 条消息、{conversations} 个会话",
  "audit.messages.count": "消息 / 会话数",
  "permissions.limited": "仍受工作区与系统边界限制",
  "permissions.effective": "当前生效：{level}",
  "permissions.globalNetwork": "全局联网设置只是默认，Bot 可独立设置网站范围。",
  "permissions.domainOutsideGlobal": "请输入有效的网站域名。",
  "permissions.domainLimited": "网站范围：{domain}",
  "tool.historyOutputNote": "历史预览：本轮运行前 32 KB 中最多 200 行，可打开完整输出。",
  "tool.outputNote": "仅保留最后 200 行，超长文本会截断。",
  "permissions.note.computer": "每个任务先弹授权卡。系统授权、不能操作的应用在「操作电脑」页。",
  "permissions.note.read_ai_config": "每次单独批准，内容先脱敏；YOLO 仅放行这一次，不记住授权",
  "permissions.note.read_messages":
    "默认允许。可读取自己的话题和所在群的获准记录；搜索限本 Bot 的私聊或当前群。",
  "permissions.note.send_out": "经连接发消息、新建或修改内容；以你的身份发送时，每次都需要你确认",
  "permissions.note.agent_delegation":
    "把一项工作交给你添加的外部 Agent（如 Codex），它用自己的账号在这个话题的文件夹里做；工作内容会发给那个 Agent 和它的模型服务商。",
  "settings.permissions": "权限",
  "sidebar.waiting": "等你处理",
  "sidebar.waitingFor": "等你处理：{title}",
  "approval.label": "操作审批",
  "approval.danger": "危险操作：请仔细检查，每次都需要你的允许。",
  "approval.deny": "拒绝",
  "approval.allowOnce": "本次允许",
  "approval.allowAlways": "一直允许",
  "approval.alwaysHint": "「一直允许」：{scope}；可在这个 Bot 资料面板的「权限与连接」里撤销",
  "approval.rememberPrograms":
    "以后在整个工作位置（含所有子目录）运行同一组程序 {programs} 不再询问",
  "approval.rememberWeb": "以后访问 {scope} 不再询问（不含子域名）",
  // Remembered form submissions in the Bot browser, per site.
  "approval.rememberSubmit": "以后在 {scope}（含子域名）提交表单不再询问",
  "permissions.submitScope": "提交表单 · {site}",
  // "always allow" on a web_fetch card remembers reading public pages for this Bot.
  "approval.rememberWebRead":
    "以后这个 Bot 读取公开网页不再询问（只读获取；Bot 浏览器、登录、提交表单仍会问，内网地址仍拒绝）",
  "permissions.webReadScope": "读取公开网页",
  // Owner decision 2026-10-23: "don't ask again" on a paid image card, per Bot + exact model.
  "approval.rememberPaidImage": "这个 Bot 用这个模型不再问（{model}）",
  "permissions.paidImageScope": "付费生成图片 · {model}",
  "approval.rememberWrite": "以后写入整个工作位置（含所有子目录）不再询问",
  "approval.groupWriteHint":
    "当前群的写文件设置需要确认。选择记住这个工作位置的写入授权后，本群成员写入同一位置无需每步确认；目录外写入仍逐次询问。",
  "approval.rememberFolder": "以后对这个文件夹的同类操作不再询问",
  "approval.chatCountdown": "剩余 {time} · 到时未处理将暂停，等待你确认",
  "approval.countdown": "剩余 {time} · 到时未处理将自动拒绝",
  "approval.paused": "已暂停，等你确认；卡片仍可允许一次或拒绝。",
  "approval.awaitingExpiry": "等待大脑确认处理结果…",
  // Maintainers 2026-11-01: the token card names the command, the tokens and the folder in rows.
  "approval.row.command": "命令",
  "approval.row.tokens": "令牌",
  "approval.row.cwd": "位置",
  "approval.tokensHidden": "{names}（不会显示值）",
  "approval.tokenInjection": "令牌只在这条命令运行时提供，命令看不到原文。",
  "approval.allowTokenAlways": "以后都允许这个令牌",
  "approval.allowTokensAlways": "以后都允许这些令牌",
  "approval.allowFuture": "以后都允许",
  "approval.whyAsk": "为什么要问",
  "approval.connectorTitle": "{bot}想用 {name} 读取：{tool}",
  "approval.secretChanged": "密钥已在别处更新，需要重新确认。请刷新待审批请求。",
  "approval.error": "未能确认处理结果，请刷新后重试。",
  "approval.loadError": "无法加载待审批操作。",
  "approval.pending": "等待你处理",
  "approval.allowed": "你允许了",
  "approval.denied": "你拒绝了",
  "approval.auto_denied": "已自动拒绝",
  "approval.cancelled": "已停止，审批取消",
  "approval.expired": "审批已过期",
  "approval.revokeHint": "可在设置里撤销",
  "facts.program": "程序",
  "facts.read": "读取",
  "facts.write": "写入",
  "facts.network": "联网",
  "facts.cwd": "当前目录",
  "facts.warning": "提示",
  "facts.value.network_target_unknown": "联网目标未知",
  "facts.value.readonly": "只读操作",
  "facts.value.topic_writable_scope":
    "选择「以后允许」会覆盖本话题当前的所有可写文件夹，不适用于其他话题；移除文件夹后不再覆盖。",
  "facts.value.incomplete_analysis": "无法完全确定会做什么，不能记住授权",
  "facts.value.windows_unisolated": "此命令将在 Windows 上以你的权限运行，没有系统隔离",
  "facts.value.local_service": "只放行这一个端口或套接字；其他端口和外网仍被沙箱拦。",
  "facts.value.outside_sandbox_login":
    "这个程序要用你自己的登录或配置（如 aws、gh、kubectl、ssh 的凭据），在沙箱里跑不通，所以直接请你批准在沙箱外运行",
  "facts.value.outside_sandbox":
    "这次在沙箱外运行，没有文件和网络隔离：能读写你的整个用户目录、访问任意网络。只放行这一次，不会记住",
  "facts.value.acp_editor_terminal_unisolated":
    "命令将由编辑器终端直接执行；Pi Bot 无法证明编辑器提供了系统隔离",
  "facts.value.editor_session_rememberable":
    "可选「本次会话都允许」：仅本 ACP 会话内，同样的程序和参数不再询问；会话结束即失效，不保存为授权",
  "facts.value.outside_delete": "将删除工作位置以外的文件",
  "facts.value.protected_command_path": "涉及本次可写工作位置以外的受保护数据",
  "facts.value.outside_workplace_write":
    "将写入工作位置以外的路径：只能允许这一次，只放开上面列出的路径，下次还会再问",
  "approval.outsideWriteFolderHint":
    "要在这里继续工作，可以通过系统选择框为本话题添加可写文件夹。添加成功后原请求作废，Bot 会重试。也可在话题的文件夹菜单中添加。",
  "approval.addWritableFolder": "把这个文件夹加为可写文件夹",
  "facts.value.outside_permissions": "将修改工作位置以外的文件权限",
  "facts.value.remove_workplace_root": "将删除整个工作位置",
  "facts.value.system_settings": "可能修改系统设置",
  "facts.value.force_push": "将强制推送 Git 历史",
  "facts.value.hard_remote_reset": "将丢弃本地修改并重置 Git 历史",
  "facts.value.shutdown": "将关闭或重启电脑",
  "facts.value.kill_init": "将终止系统关键进程",
  "facts.value.killall_without_target": "将批量终止进程",
  "facts.value.download_and_execute": "将下载并执行外部代码",
  "facts.value.readableConversations": "此 Bot 可访问的话题与群聊",
  "facts.value.scriptByContent": "按内容核对过的脚本（内容改了会再问）",
  "facts.value.currentChatHistory": "此 Bot 的私聊或当前群的过往话题",
  "facts.value.unknownWarning": "无法完全确定此操作的影响，请仔细检查",
  "isolation.warning": "命令在执行设备上不隔离运行。",
  "isolation.reason.windows_unisolated":
    "Windows 暂不支持命令隔离，每条命令都要你批准后才直接运行。",
  "isolation.reason.acp_editor_terminal_unisolated":
    "命令由编辑器终端直接执行；Pi Bot 无法证明编辑器提供了系统隔离。",
  "isolation.reason.platform_unsupported": "这个系统不支持命令隔离。",
  "isolation.reason.sandbox_dependencies_or_runtime_unavailable": "隔离组件缺失或无法启动。",
  "isolation.reason.linux_bubblewrap_missing":
    "没有找到 bubblewrap（bwrap），命令隔离需要它。安装（Debian/Ubuntu：sudo apt install bubblewrap；Fedora：sudo dnf install bubblewrap）后重启执行端。",
  "isolation.reason.linux_socat_missing":
    "没有找到 socat，命令隔离用它转发沙箱内的网络访问。安装（Debian/Ubuntu：sudo apt install socat）后重启执行端。",
  "isolation.reason.linux_userns_disabled": linuxIsolationRemedies.linux_userns_disabled.zh,
  "isolation.reason.linux_userns_limit_zero": linuxIsolationRemedies.linux_userns_limit_zero.zh,
  "isolation.reason.linux_seccomp_helper_unavailable":
    linuxIsolationRemedies.linux_seccomp_helper_unavailable.zh,
  "isolation.reason.linux_userns_restricted": linuxIsolationRemedies.linux_userns_restricted.zh,
  "isolation.reason.isolation_check_unfinished":
    "沙箱自检还没完成（电脑较忙），运行命令时会重新检查。",
  "isolation.available": "已开启",
  "isolation.unavailable": "不可用",
  "workplaces.title": "工作位置",
  "workplaces.headerLabel": "工作位置",
  "workplaces.header": "工作位置 {name}，点击打开工作位置面板",
  "workplaces.unavailable": "无法加载",
  "workplaces.folderMissing": "文件夹已不存在",
  "workplaces.runnerOffline": "执行端离线",
  "workplaces.folderMissingHint":
    "这个话题的文件夹已不存在或被移走。请在上方改选文件夹，或改用 Bot 主目录。",
  "workplaces.home": "Bot 主目录",
  "workplaces.note": "Bot 只能在这些文件夹里写文件。",
  "workplaces.current": "当前目录",
  "workplaces.setCurrent": "设为当前",
  "workplaces.add": "添加文件夹",
  "workplaces.remove": "移除",
  "workplaces.removeNamed": "移除 {name}",
  "workplaces.close": "关闭工作位置",
  "workplaces.permissions": "在设置里调整权限 →",
  "workplaces.error": "无法更新工作位置，请重试。",
  "permissions.note": "这是所有 Bot 的默认权限，每个 Bot 可以在自己资料里的「权限」单独改。",
  "permissions.error": "无法加载或保存权限，请重试。",
  "permissions.operations": "本机操作",
  "permissions.category.run_command": "运行命令",
  "permissions.category.computer": "操作电脑",
  "permissions.category.connector": "使用插件",
  "permissions.note.connector":
    "调用对该 Bot 可见的已启用工具；只读工具按权限调用，写入经过发送草稿。",
  "permissions.category.read_file": "读文件",
  "permissions.category.list_dir": "列目录",
  "permissions.category.write_file": "写文件",
  "permissions.category.memory": "记忆",
  "permissions.category.read_ai_config": "读其他 AI 工具的配置",
  "permissions.category.read_messages": "读聊天消息",
  "permissions.category.send_out": "对外发送",
  "permissions.category.agent_delegation": "交给外部 Agent",
  "permissions.category.web": "访问网站",
  "permissions.note.run_command":
    "工作位置内已知只读命令直接运行；总是允许时，隔离内的命令也直接运行。位置外写入、非包仓库联网、安装与后台启动仍需确认，受保护位置仍拒绝",
  "permissions.note.read_file":
    "工作位置以外的文件会先问你；允许一次后，同一文件夹在这次回复里不再问",
  "permissions.note.list_dir": "看文件夹里有什么、找文件、搜索文件内容",
  "permissions.note.write_file":
    "工作位置内按这里的设置写入；位置外的写入逐次确认，受保护位置仍拒绝。执行端不允许位置外写入；可用的文件检查点可在改动页恢复",
  "permissions.note.web":
    "访问和读取公开网页默认允许。设为「询问」会按权限提示。每个网站首次自动登录或提交表单仍会问你。",
  "permissions.level.never": "不允许",
  "permissions.level.ask": "询问",
  "permissions.level.always": "总是允许",
  "permissions.grants": "已一直允许的",
  "permissions.revoke": "撤销",
  "permissions.noGrants": "没有已记住的授权。需要授权时会按权限设置询问。",
  "permissions.grantsError": "无法加载或撤销授权，请重试。",
  "permissions.loadMore": "加载更多",
  "permissions.network": "联网",
  "permissions.allowNetwork": "Bot 跑的命令可以联网",
  "permissions.networkNote": "关闭后仅限名单；自动执行的命令仍只开放包仓库和你添加的网站",
  "permissions.commandDomainsNote":
    "自动执行的命令只开放包仓库和这份清单。需要访问飞书、GitHub 等服务时，在这里添加域名；不会自动关闭上面的联网开关。",
  "permissions.noExplicitDomains": "还没有添加网站。",
  "permissions.noDomains": "列表为空：不允许访问任何网站。",
  "permissions.domain": "网站域名",
  "permissions.addDomain": "添加网站",
  "permissions.domainInvalid": "请输入域名，不含协议、端口或路径（最多 200 项）。",
  "permissions.removeDomain": "移除网站 {domain}",
  "permissions.paths": "命令搜索路径",
  "permissions.pathsNote": "可选：在默认 PATH 之外添加目录，每行一个绝对路径。",
  "permissions.pathsInvalid": "请输入不含控制字符的绝对路径，最多 200 项。",
  "permissions.viewAudit": "查看操作记录 →",
  "permissions.back": "← 返回权限",
  "audit.title": "操作记录",
  "audit.note": "审批与执行的事实记录，保留 90 天，不含命令输出或文件内容。",
  "audit.bot": "Bot",
  "audit.kind": "类型",
  "audit.allBots": "全部 Bot",
  "audit.allKinds": "全部类型",
  "audit.botsError": "无法加载 Bot 名单，暂用 ID 显示。",
  "audit.error": "无法加载操作记录，请重试。",
  "audit.empty": "还没有操作记录。",
  "audit.details": "查看事实详情",
  "audit.kind.approval.requested": "请求审批",
  "audit.kind.approval.paused": "到期暂停",
  "audit.kind.approval.resolved": "审批处理",
  "audit.kind.exec.started": "开始执行",
  "audit.kind.exec.finished": "执行结束",
  "audit.kind.file.written": "写入文件",
  "audit.kind.grant.created": "记住授权",
  "audit.kind.grant.revoked": "撤销授权",
  "audit.kind.policy.denied": "策略拒绝",
  "audit.summary.approval.requested": "等待你确认此操作。",
  "audit.summary.approval.paused": "审批到期，运行已暂停，等待你的决定。",
  "audit.summary.approval.resolved": "审批已处理。",
  "audit.summary.exec.started": "命令开始执行。",
  "audit.summary.exec.finished": "命令执行结束。",
  "audit.summary.file.written": "文件已写入。",
  "audit.summary.grant.created": "已记住授权，可在权限设置中撤销。",
  "audit.summary.grant.revoked": "已撤销记住的授权。",
  "audit.summary.policy.denied": "工具已被拦截。",
  "audit.summary.stopped": "命令已停止。",
  "audit.summary.timedOut": "命令执行超时。",
  "tool.run_command": "运行命令",
  "tool.read_file": "读文件",
  "tool.send_file": "发文件",
  "tool.reveal_in_folder": "在文件夹中显示",
  "tool.local_network": "查看本机网络",
  "tool.write_file": "写文件",
  "tool.edit_file": "改文件",
  "tool.list_dir": "列目录",
  "tool.find_files": "找文件",
  "tool.search_text": "搜索内容",
  "tool.web_fetch": "读网页",
  "tool.execution_targets": "查看执行端",
  "tool.workplace_use_runner": "提议换到执行端文件夹",
  "tool.delegate_to_agent": "交给外部 Agent",
  "tool.phone_media": "读取手机照片",
  "tool.phone_media_get": "查看手机照片",
  "tool.phone_sms_code": "接收短信验证码",
  "tool.phone_calls": "读取通话记录",
  "tool.phone_notifications": "读取手机通知",
  "tool.tool_discover": "查找工具",
  "tool.group_plan": "制定计划",
  "tool.todo_pause": "暂停任务清单",
  "tool.unknown": "使用工具",
  "tool.step": "{action}{target} · 第 {step} 步",
  "tool.sandboxBlocked": "沙箱拦下了：{kind} {target}{program}（规则：{rule}）",
  "tool.networkSettingsBlocked": "联网设置拦下了：{target} 不在允许的网站名单里，命令未运行",
  "tool.sandboxSeeApproval": "查看审批 ↓",
  "tool.website.add": "允许访问 {domain}…",
  "tool.website.saved": "{domain} 已加入，可重试 · 查看范围",
  "tool.website.title": "加入允许的网站",
  "tool.website.domain": "允许网站：{domain}（网页访问沿用现有规则，也包括其子域名）",
  "tool.website.scope": "生效范围",
  "tool.website.bot": "这个 Bot",
  "tool.website.group": "这个群",
  "tool.website.global": "全局默认",
  "tool.website.botHelp":
    "只加入发起这次命令的 Bot 的允许网站，其他 Bot 和群不变。可在这个 Bot 的权限设置中移除。",
  "tool.website.groupHelp":
    "只加入发起这次命令的群的允许网站，该群成员执行群任务时使用；不会修改成员的私聊权限。可在群权限设置中移除。",
  "tool.website.globalHelp":
    "加入全局默认允许网站，跟随默认网络配置的 Bot 和群都能使用；已有独立网络配置的 Bot 和群不会被覆盖。可在设置 → 权限 → 联网中移除。",
  "tool.website.noRetry":
    "仅保存网站权限，联网开关和其他授权保持原设置。保存后请重试命令；不会自动执行。私网和本机服务仍按原规则授权。",
  "tool.website.confirm": "加入允许的网站",
  "tool.website.full":
    "这个范围的允许网站已满（200 项）。请先在权限设置中移除不需要的网站，再重试。",
  "tool.website.unavailable": "这条拦截记录或所属 Bot／群已不可用。请回到当前对话重新发起操作。",
  "tool.sandboxKind.outside_workplace_write": "工作位置外写入",
  "tool.sandboxKind.protected_name": "受保护的位置",
  "tool.sandboxKind.git_resource": "Git 资源",
  "tool.sandboxKind.network": "联网",
  "tool.sandboxKind.local_service": "本机服务",
  "tool.sandboxKind.system_service": "系统服务",
  "tool.sandboxKind.protected_path": "受保护的位置",
  "tool.sandboxKind.credential_read": "凭据读取",
  "tool.sandboxKind.protected_read": "受保护的读取",
  "tool.sandboxKind.other": "沙箱规则",
  "tool.executing": "正在{action}{target} · 第 {step} 步",
  "tool.group.summary": "执行了 {count} 步 · {types}",
  "tool.group.summaryOne": "执行了 {count} 步 · {types}",
  "tool.group.progress": "已完成 {count} 步",
  "tool.group.count": "{tool} {count} 次",
  "tool.group.separator": "、",
  "tool.status.pending": "等待审批",
  "tool.status.running": "运行中",
  "tool.status.waitingFolder": "等 {bot} 改完",
  "tool.status.waitingFolderUnknown": "等另一个 Bot 改完",
  "tool.status.waitingReviewFolder": "等待{bot}释放工作区后开始审查",
  "tool.status.waitingReviewFolderUnknown": "等待其他 Bot 释放工作区后开始审查",
  "tool.status.done": "已完成",
  "tool.status.error": "失败",
  "tool.status.blocked": "已拒绝",
  "tool.status.aborted": "已停止",
  "tool.exit": "退出码 {code}",
  "tool.duration": "耗时 {seconds} 秒",
  "tool.openLog": "打开完整输出",
  "tool.openFile": "打开写入文件",
  "tool.openError": "无法打开文件或输出，请检查操作记录与本地文件。",
  "tool.noOutput": "暂无输出。",
  "tool.searchHistoryReference": "聊天片段仅供参考。",
  "tool.searchHistoryPending": "历史记录仍在建立索引，结果可能不全。",
  "tool.searchHistoryOpen": "打开原话题",
  "tool.searchHistoryEmpty": "没有匹配的聊天片段。",
} as const;

export const permissionsEn: { [K in keyof typeof permissionsZh]: string } = {
  "permissions.serviceTrust": "Certificate trust evaluation",
  "permissions.serviceDirectory": "User and group lookup",
  "permissions.serviceNotification": "System notifications",
  "permissions.serviceOther": "System service {service}",
  "permissions.sandboxRemembered": "Remembered sandbox permissions",
  "permissions.sandboxRememberedSummary":
    "{count} items · Write paths {writes} · Local services {local} · System services {system}",
  "permissions.sandboxRememberedSummary.one":
    "{count} item · Write paths {writes} · Local services {local} · System services {system}",
  "permissions.sandboxWrites": "Write paths",
  "permissions.sandboxLocal": "Local services",
  "permissions.sandboxSystem": "System services",
  "approval.sandboxRemember": "Allow and don't ask again in this folder",
  "facts.value.system_service": "Only this system service is allowed.",
  "policy.reason.system_service_once": "Allow this program to use the listed system service",

  "policy.reason.git_entry_confirmation_required":
    "This Git command would run project hooks or executable configuration (listed below). Confirm it explicitly this time; it is not remembered, and YOLO, existing grants and routines cannot answer it",
  "facts.value.git_entry_once":
    "Allows the listed entries to run this one time. Only the entry files are pinned, not the programs they call. If any entry or config changes before launch, the run is refused",
  "policy.reason.git_entry_include_unknown":
    "The repository's Git config uses include / includeIf, so which programs would run cannot be confirmed; unsupported",
  "policy.reason.git_entry_layout_unsupported":
    "Hooks in this Git layout (--git-dir, core.worktree, submodule recursion and similar) cannot be confirmed one by one; unsupported",
  "policy.reason.git_entry_scan_incomplete":
    "Could not read the repository's hooks and config within limits, so what would run is unknown; not run",
  "policy.reason.git_entry_compound":
    "Git inside this compound command would run project hooks or executable configuration, which cannot be confirmed there; run that Git command on its own",
  "policy.reason.git_entry_dynamic":
    "The command changes the repository, configuration or a program to run through environment variables, -c or an alias, so what would run cannot be confirmed",
  "policy.reason.git_entry_unsupported_target":
    "This Git command would run project hooks or executable configuration, which cannot be confirmed in routines, background, Docker, outside-sandbox runs, on Windows or on a device that cannot check them; not run",
  "policy.reason.git_hooks_path_confirmation_required":
    "Confirm this one project Git hooksPath change. It cannot be remembered and does not run or authorize any hook.",
  "facts.value.git_hooks_path_setter":
    "Only change project core.hooksPath. Do not read hook contents, run hooks, or authorize later Git execution.",
  "policy.reason.git_inline_execution_unsupported":
    "This Git command may invoke an explicit executable configuration override. Controlled per-use execution is unsupported; ordinary permissions, YOLO or existing grants cannot authorize it. Not executed.",
  "policy.reason.git_hook_confirmation_required":
    "Running this pre-commit native-program hook requires explicit confirmation for this call; permission is not remembered",
  "policy.reason.git_hook_unsupported":
    "This Git hook, script shape or execution target does not support controlled execution; the raw command will not run instead",
  "policy.reason.git_hook_unverified":
    "The Git hook, program or workspace differs from the prepared version; nothing ran",
  "facts.value.git_hook_literal_exec":
    "Run only the default pre-commit hook's fixed system native program and shown literal arguments. No Node/scripts, network, credentials or config changes. This call only; not remembered",
  "policy.reason.host_ssh_not_enabled":
    "This SSH host is not enabled: Settings → Permissions → Advanced → SSH hosts",
  "policy.reason.host_ssh_identity_required":
    "No private key is chosen for this host yet; choose one in Settings → Permissions → Advanced → SSH hosts",
  "policy.reason.host_ssh_unsupported":
    "This SSH form, configuration, or execution target is unsupported. The entire .ssh directory will not be opened, and no generic command fallback will run.",
  "policy.reason.ssh_config_private":
    "~/.ssh is a credential folder and cannot be read; connect with ssh ALIAS 'COMMAND'",
  "policy.reason.host_ssh_unsupported_syntax":
    "This SSH form is not supported: only ssh ALIAS 'REMOTE_COMMAND' with a few safe options",
  "policy.reason.host_ssh_unsupported_target":
    "Host SSH currently works only in ordinary macOS chats on this computer",
  "policy.reason.host_ssh_configuration_unavailable": "This alias is not in ~/.ssh/config",
  "policy.reason.host_ssh_unsupported_configuration":
    "This host's SSH configuration uses an unsupported feature; Pi Bot will not drop it to connect",
  "policy.reason.host_ssh_config_strict_host_key":
    "This host sets StrictHostKeyChecking to something other than yes (such as accept-new); change it to yes and retry",
  "policy.reason.host_ssh_config_option":
    "This host's SSH configuration uses an option Pi Bot does not support; see Settings → Permissions → Advanced → SSH hosts for the exact line",
  "policy.reason.host_ssh_config_user":
    "This host has no usable User (one @ is allowed, e.g. user@machine); add it and retry",
  "policy.reason.host_ssh_config_identity_outside_ssh":
    "This host's private key is outside ~/.ssh; move it into ~/.ssh with mode 600 or change IdentityFile, then retry",
  "policy.reason.host_ssh_unverified":
    "The SSH command, configuration, or file version no longer matches. Access was not granted.",
  "facts.value.host_ssh_static_identity":
    "Uses a static alias and one identity only; does not run user proxy commands or system configuration. Local SSH diagnostics and remote stderr are suppressed.",
  "policy.reason.git_configuration_confirmation_required":
    "This controlled Git configuration change needs your explicit confirmation each time; permission cannot be remembered",
  "policy.reason.git_configuration_unsupported":
    "This Git configuration operation or execution target does not support controlled changes; the raw command will not run instead",
  "policy.reason.git_configuration_unverified":
    "The Git operation, target or prepared version did not match; no write permission was granted",
  "policy.reason.git_configuration_project_setter":
    "Change one ordinary Git configuration key in the current project through a controlled operation",
  "policy.reason.git_configuration_global_setter":
    "Change only the current user's Git name or email through a controlled operation",
  "facts.value.git_configuration_project_setter":
    "Change one ordinary key in the shown project config; no whole-file or directory permission. The value is omitted",
  "facts.value.git_configuration_global_setter":
    "Change only name or email in the shown user config, with confirmation each time. No directory permission; the value is omitted",
  "policy.reason.git_configuration_sensitive_project_setter":
    "Change one executable Git configuration key in this project without running it; using that entry later needs a separate confirmation",
  "facts.value.git_configuration_sensitive_project_setter":
    "Change one executable key (helper / filter / sshCommand) in the shown project config, this time only and not remembered. The program is not run now; using it later needs its own confirmation. The value is omitted; no whole-file or directory permission",
  "policy.reason.task_web_read": "You allowed public web reads for this group task",
  "approval.allowTaskWeb": "Allow public web reads for this task",
  "approval.taskWebsiteHint":
    "Shared by this group task or plan's members, retries and reassignments; public read-only GET only. Excludes the Bot browser, logins, forms and private addresses. Expires on task end, cancellation, plan completion or restart.",
  "policy.reason.conversation_web_read":
    "You allowed public web reads from this website in this conversation",
  "approval.allowConversation": "Allow this website in this conversation",
  "approval.conversationWebsiteHint":
    "Public read-only GET on {domain} and its subdomains only; excludes browser, login, forms and private networks. Only this Bot and conversation; expires on restart.",
  "permissions.singleRootScope": "Single writable root: {root}",
  "permissions.topicGrantScope":
    "Topic {topic} · Current writable roots: {roots} (follows topic changes)",
  "permissions.topicGrantUnavailable": "Working folders unavailable; rechecked before execution",
  "permissions.topicGrantNoRoots": "No writable roots",
  "permissions.yoloUnisolated": "YOLO runs commands automatically on Windows",
  "permissions.yoloWindowsConsentedAt":
    "Consented on {date}. Ordinary commands run directly in conversations with YOLO on. Dangerous commands still ask. Withdraw to see the explanation next time you turn on YOLO.",
  "permissions.yoloWindowsConsented":
    "Consented. Ordinary commands run directly in conversations with YOLO on. Dangerous commands still ask. Withdraw to see the explanation next time you turn on YOLO.",
  "permissions.yoloWindowsNotConsented": "Consent not given. You can confirm when turning on YOLO.",
  "permissions.yoloWindowsWithdraw": "Withdraw",
  "permissions.yoloWindowsWithdrawFailed": "Couldn't withdraw consent. Try again.",
  "permissions.strictSandbox": "Strict sandbox",
  "permissions.strictSandboxNote":
    "When on, a command the sandbox blocks only explains why; running it once outside the sandbox is not offered, and the list below is ignored.",
  "permissions.sandboxAutoOutside": "Automatically remembered",
  "permissions.sandboxAutoDelete": "Delete",
  "permissions.sandboxOutsideCommands": "Commands that run outside the sandbox",
  "permissions.sandboxOutsideCommandsNote":
    "One per line: the program and fixed arguments, optionally ending in * (for example docker compose *). Every part of a compound command must match; redirects, cd and variable expansion never match. Manual entries require confirmation each time. Automatic entries apply only to the listed folder and follow ordinary permissions. Outside runs have no file or network isolation.",
  "permissions.sandboxOutsideCommandsStrict": "Strict sandbox is on, so the list is not in effect.",
  "permissions.sandboxOutsideCommandsInvalid":
    "Invalid entry: one per line, a program and its arguments, * only at the end, at most 32 entries.",
  "permissions.unisolated": "Unisolated",
  "permissions.note.run_command.windows":
    "Windows has no command sandbox. Supported read-only commands, such as dir and type, run directly when permissions allow.",
  "permissions.info.run_command.windows":
    "Don't allow blocks commands. Supported read-only commands run directly when permissions allow. Ordinary commands ask each time unless YOLO is on in the conversation and you consented to unisolated execution.",
  "permissions.windowsAlwaysUnavailable":
    "Windows commands have no system isolation and cannot be set to Always; YOLO auto-approval must be enabled separately",
  "permissions.connectionsAndSending": "Connections and sending",
  "permissions.confirmEverySend": "This Bot asks you before every send",
  "approval.connection": "Connected app",
  "approval.connectedTool": "This operation",
  "approval.connectionId": "Connection ID",
  "approval.toolId": "Tool ID",
  "approval.connectorDetails": "Connection and tool details",
  "approval.connectorHint.once": "Allow this read-only call only. Ask again next time.",
  "approval.connectorHint.bot":
    "Allow this Bot to use the connection. Tool permissions and outgoing confirmations still apply.",
  "approval.connectorHint.all":
    "Allow all Bots to use the connection. Tool permissions and outgoing confirmations still apply.",
  "approval.connectorAccess": "Access to this connection",
  "approval.connectorOnce": "Only this time",
  "approval.connectorBot": "Always allow this Bot",
  "approval.connectorAll": "Allow all Bots",
  "approval.connectorAllow": "Allow",

  "log.output": "Command output",
  "log.search": "Search output",
  "log.matches": "{current} of {total} matches",
  "log.previous": "Previous",
  "log.next": "Next",
  "log.wrap": "Wrap lines",
  "log.copy": "Copy all",
  "log.reveal.mac": "Show in Finder",
  "log.reveal.win": "Show in Explorer",
  "log.reveal.linux": "Show in file manager",
  "log.close": "Close",
  "log.truncated": "Showing only the first 5 MB",
  "log.empty": "This command produced no output",
  "log.missing": "This command left no output log",
  "log.error": "Unable to read the output log.",
  "log.actionError": "Action failed. Please retry.",
  "log.unsupported": "Revealing files is unsupported on this platform.",
  "log.more": "Load more",
  "permissions.adjust": "Adjust permissions",
  "permissions.scope": "Permission scope",
  "permissions.allBots": "All bots",
  "permissions.followGlobal": "Follow global settings",
  "permissions.ceiling": "Global default: {level}; this Bot can choose independently.",
  "permissions.custom": "Independent setting",
  "tool.read_messages": "Query chat history",
  "audit.messages.read": "Read {messages} messages and {conversations} conversations",
  "audit.messages.count": "Messages / conversations",
  "permissions.limited": "Working folder and system boundaries still apply",
  "permissions.effective": "Effective level: {level}",
  "permissions.globalNetwork":
    "Global network settings are defaults; this Bot can choose its own website scope.",
  "permissions.domainOutsideGlobal": "Enter a valid website domain.",
  "permissions.domainLimited": "Website scope: {domain}",
  "tool.historyOutputNote":
    "History preview: up to 200 lines from the first 32 KB of this run. Open full output for more.",
  "tool.outputNote": "Only the last 200 lines are kept; very long text is truncated.",
  "permissions.note.computer":
    "Each task asks first with a grant card. System permissions and blocked apps are on the Computer use page.",
  "permissions.note.read_ai_config":
    "Approve each read; sensitive values are removed first. YOLO allows once without remembering.",
  "permissions.note.read_messages":
    "Allowed by default. Read its own topics and permitted group history; search only this Bot’s private chats or the current group.",
  "permissions.note.send_out":
    "Messages and changes made through connections. Sending as you requires your confirmation every time.",
  "permissions.note.agent_delegation":
    "Hand a piece of work to an external agent you added (such as Codex); it works in this topic's folder with its own account. The work is sent to that agent and its model provider.",
  "settings.permissions": "Permissions",
  "sidebar.waiting": "Needs your attention",
  "sidebar.waitingFor": "Waiting for you: {title}",
  "approval.label": "Operation approval",
  "approval.danger": "Dangerous operation: review carefully. Permission is required every time.",
  "approval.deny": "Deny",
  "approval.allowOnce": "Allow this time",
  "approval.allowAlways": "Always allow",
  "approval.alwaysHint":
    "“Always allow”: {scope}. You can revoke it on this Bot’s Permissions & connections tab.",
  "approval.rememberPrograms":
    "Don’t ask again for the same programs ({programs}) in the working folders, including all subfolders",
  "approval.rememberWeb": "Don’t ask again for {scope} (subdomains excluded)",
  "approval.rememberSubmit":
    "Don’t ask again before submitting forms on {scope} (subdomains included)",
  "permissions.submitScope": "Submit forms · {site}",
  "approval.rememberWebRead":
    "Don’t ask again when this Bot reads public web pages (read-only fetch; the Bot browser, logins and form submissions still ask, private addresses stay blocked)",
  "permissions.webReadScope": "Read public web pages",
  "approval.rememberPaidImage": "Don’t ask again for this Bot with this model ({model})",
  "permissions.paidImageScope": "Paid image generation · {model}",
  "approval.rememberWrite":
    "Don’t ask again for writes in the working folders, including all subfolders",
  "approval.groupWriteHint":
    "This group's file-write setting requires approval. Remembering write access to these working folders covers the group's members, so later steps in the same location do not ask again. Writes outside these working folders still require approval each time.",
  "approval.rememberFolder": "Don’t ask again for this kind of operation in this folder",
  "approval.chatCountdown": "{time} remaining · Pauses for your decision when time runs out",
  "approval.countdown": "{time} remaining · Automatically denied when time runs out",
  "approval.paused": "Paused for your decision. You can still allow once or deny.",
  "approval.awaitingExpiry": "Waiting for the background service to confirm the result…",
  "approval.row.command": "Command",
  "approval.row.tokens": "Tokens",
  "approval.row.cwd": "Folder",
  "approval.tokensHidden": "{names} (value never shown)",
  "approval.tokenInjection":
    "The token is provided only while this command runs; the command text never contains it.",
  "approval.allowTokenAlways": "Always allow this token",
  "approval.allowTokensAlways": "Always allow these tokens",
  "approval.allowFuture": "Always allow",
  "approval.whyAsk": "Why am I asked?",
  "approval.connectorTitle": "{bot} wants to use {name} to read: {tool}",
  "approval.secretChanged":
    "Secrets changed elsewhere and need confirmation again. Refresh pending approvals.",
  "approval.error": "Couldn’t confirm the decision. Refresh and try again.",
  "approval.loadError": "Couldn’t load pending approvals.",
  "approval.pending": "Waiting for your decision",
  "approval.allowed": "You allowed this",
  "approval.denied": "You denied this",
  "approval.auto_denied": "Automatically denied",
  "approval.cancelled": "Stopped; approval cancelled",
  "approval.expired": "Approval expired",
  "approval.revokeHint": "Revoke in Settings",
  "facts.program": "Programs",
  "facts.read": "Reads",
  "facts.write": "Writes",
  "facts.network": "Network",
  "facts.cwd": "Working directory",
  "facts.warning": "Notice",
  "facts.value.network_target_unknown": "Network target unknown",
  "facts.value.readonly": "Read-only operation",
  "facts.value.topic_writable_scope":
    "Remembering covers this topic’s current writable folders only, not other topics; removing a folder removes it from that scope.",
  "facts.value.incomplete_analysis":
    "The operation cannot be fully determined; permission cannot be remembered",
  "facts.value.windows_unisolated":
    "This command runs on Windows with your permissions and without system isolation",
  "facts.value.local_service":
    "Only this port or socket is allowed; other ports and the internet remain blocked by the sandbox.",
  "facts.value.outside_sandbox_login":
    "This program needs your own login or configuration (aws, gh, kubectl, ssh credentials and the like) and cannot work inside the sandbox, so it asks to run outside it",
  "facts.value.outside_sandbox":
    "This run is outside the sandbox, with no file or network isolation: it can read and write your whole user folder and reach any network. Allowed this once only, never remembered",
  "facts.value.acp_editor_terminal_unisolated":
    "The command runs directly in the editor terminal; Pi Bot cannot verify system isolation there",
  "facts.value.editor_session_rememberable":
    "“Allow for this session” covers the same program and arguments in this ACP session only; it ends with the session and is never saved as a permission",
  "facts.value.outside_delete": "Deletes files outside the working folders",
  "facts.value.protected_command_path":
    "References protected data outside this run's writable folders",
  "facts.value.outside_workplace_write":
    "Writes outside the working folders: allowed for this call only, just the paths listed above; it asks again next time",
  "approval.outsideWriteFolderHint":
    "Use the system picker to add a writable folder to this topic. Adding it invalidates this request so the Bot can retry. You can also add folders from the topic’s folder menu.",
  "approval.addWritableFolder": "Add this folder as writable",
  "facts.value.outside_permissions": "Changes file permissions outside the working folders",
  "facts.value.remove_workplace_root": "Deletes an entire working folder",
  "facts.value.system_settings": "May change system settings",
  "facts.value.force_push": "Force-pushes Git history",
  "facts.value.hard_remote_reset": "Discards local changes and resets Git history",
  "facts.value.shutdown": "Shuts down or restarts the computer",
  "facts.value.kill_init": "Terminates a critical system process",
  "facts.value.killall_without_target": "Terminates multiple processes",
  "facts.value.download_and_execute": "Downloads and executes external code",
  "facts.value.readableConversations": "Conversations and groups accessible to this Bot",
  "facts.value.scriptByContent": "A script checked by its content (asks again if it changes)",
  "facts.value.currentChatHistory":
    "Past topics in this Bot’s private chats or in the current group",
  "facts.value.unknownWarning": "The impact cannot be fully determined; review carefully",
  "isolation.warning": "Commands run without isolation on the execution device.",
  "isolation.reason.windows_unisolated":
    "Windows doesn't support command isolation yet. Each command runs directly only after you approve it.",
  "isolation.reason.acp_editor_terminal_unisolated":
    "The command runs directly in the editor terminal; Pi Bot cannot verify system isolation there.",
  "isolation.reason.platform_unsupported": "This system doesn't support command isolation.",
  "isolation.reason.sandbox_dependencies_or_runtime_unavailable":
    "The isolation components are missing or failed to start.",
  "isolation.reason.linux_bubblewrap_missing":
    "bubblewrap (bwrap) is missing and command isolation needs it. Install it (Debian/Ubuntu: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap), then restart the execution device.",
  "isolation.reason.linux_socat_missing":
    "socat is missing; command isolation uses it to forward network access inside the sandbox. Install it (Debian/Ubuntu: sudo apt install socat), then restart the execution device.",
  "isolation.reason.linux_userns_disabled": linuxIsolationRemedies.linux_userns_disabled.en,
  "isolation.reason.linux_userns_limit_zero": linuxIsolationRemedies.linux_userns_limit_zero.en,
  "isolation.reason.linux_seccomp_helper_unavailable":
    linuxIsolationRemedies.linux_seccomp_helper_unavailable.en,
  "isolation.reason.linux_userns_restricted": linuxIsolationRemedies.linux_userns_restricted.en,
  "isolation.reason.isolation_check_unfinished":
    "The sandbox self-check has not finished (the computer is busy); it is checked again when a command runs.",
  "isolation.available": "Enabled",
  "isolation.unavailable": "Unavailable",
  "workplaces.title": "Working folders",
  "workplaces.headerLabel": "Working in",
  "workplaces.header": "Working in {name}; open working folders",
  "workplaces.unavailable": "Unavailable",
  "workplaces.folderMissing": "Folder no longer exists",
  "workplaces.runnerOffline": "Runner offline",
  "workplaces.folderMissingHint":
    "This topic's folder no longer exists or was moved. Choose another folder above, or use the Bot home.",
  "workplaces.home": "Bot home",
  "workplaces.note": "Bots can only write files in these folders.",
  "workplaces.current": "Current directory",
  "workplaces.setCurrent": "Set as current",
  "workplaces.add": "Add folder",
  "workplaces.remove": "Remove",
  "workplaces.removeNamed": "Remove {name}",
  "workplaces.close": "Close working folders",
  "workplaces.permissions": "Adjust permissions in Settings →",
  "workplaces.error": "Couldn’t load or update working folders. Try again.",
  "permissions.note":
    "These are the default permissions for every Bot. Each Bot can change them under Permissions in its profile.",
  "permissions.error": "Couldn’t load or save permissions. Try again.",
  "permissions.operations": "Local operations",
  "permissions.category.run_command": "Run commands",
  "permissions.category.computer": "Use computer",
  "permissions.category.connector": "Use plugins",
  "permissions.note.connector":
    "Call enabled tools visible to this Bot. Read-only tools follow connector permissions; writes use send drafts.",
  "permissions.category.read_file": "Read files",
  "permissions.category.list_dir": "List folders",
  "permissions.category.write_file": "Write files",
  "permissions.category.memory": "Memory",
  "permissions.category.read_ai_config": "Read other AI tool settings",
  "permissions.category.read_messages": "Read messages",
  "permissions.category.send_out": "Send externally",
  "permissions.category.agent_delegation": "Hand work to external agents",
  "permissions.category.web": "Visit websites",
  "permissions.note.run_command":
    "Known read-only commands in working folders run directly. Always also runs isolated commands directly; outside writes, non-package network access, installation and background starts still need approval. Protected locations remain blocked",
  "permissions.note.read_file":
    "Files outside working folders ask first; once allowed, that folder isn’t asked again in the same reply",
  "permissions.note.list_dir": "See what is in a folder, find files, search file contents",
  "permissions.note.write_file":
    "Writes inside working folders follow this setting. Outside writes ask each time; protected locations remain blocked. Runners cannot write outside working folders. Available file checkpoints can be restored from the changes page",
  "permissions.note.web":
    "Visiting and reading public pages are allowed by default. Choose Ask for prompts. The first automatic sign-in or form submission on each site still asks.",
  "permissions.level.never": "Never",
  "permissions.level.ask": "Ask",
  "permissions.level.always": "Always",
  "permissions.grants": "Always allowed",
  "permissions.revoke": "Revoke",
  "permissions.noGrants": "No remembered permissions. Requests follow your permission settings.",
  "permissions.grantsError": "Couldn’t load or revoke permissions. Try again.",
  "permissions.loadMore": "Load more",
  "permissions.network": "Network",
  "permissions.allowNetwork": "Commands run by bots can access the network",
  "permissions.networkNote":
    "When off, listed sites only. Automatic commands use package repositories and sites you add",
  "permissions.commandDomainsNote":
    "Automatic commands can reach only package repositories and this list. Add domains for services such as Feishu or GitHub here; editing the list keeps the network switch unchanged.",
  "permissions.noExplicitDomains": "No websites added yet.",
  "permissions.noDomains": "The list is empty: no websites are allowed.",
  "permissions.domain": "Website domain",
  "permissions.addDomain": "Add website",
  "permissions.domainInvalid":
    "Enter a domain without a scheme, port, or path (up to 200 entries).",
  "permissions.removeDomain": "Remove website {domain}",
  "permissions.paths": "Command search paths",
  "permissions.pathsNote":
    "Optional: add directories beyond the default PATH, one absolute path per line.",
  "permissions.pathsInvalid":
    "Enter absolute paths without control characters; at most 200 entries.",
  "permissions.viewAudit": "View activity records →",
  "permissions.back": "← Back to permissions",
  "audit.title": "Activity records",
  "audit.note":
    "Approval and execution facts, retained for 90 days. No command output or file content.",
  "audit.bot": "Bot",
  "audit.kind": "Type",
  "audit.allBots": "All bots",
  "audit.allKinds": "All types",
  "audit.botsError": "Couldn’t load bot names; IDs are shown instead.",
  "audit.error": "Couldn’t load activity records. Try again.",
  "audit.empty": "No activity records yet.",
  "audit.details": "View fact details",
  "audit.kind.approval.requested": "Approval requested",
  "audit.kind.approval.paused": "Approval paused",
  "audit.kind.approval.resolved": "Approval resolved",
  "audit.kind.exec.started": "Execution started",
  "audit.kind.exec.finished": "Execution finished",
  "audit.kind.file.written": "File written",
  "audit.kind.grant.created": "Permission remembered",
  "audit.kind.grant.revoked": "Permission revoked",
  "audit.kind.policy.denied": "Denied by policy",
  "audit.summary.approval.requested": "Waiting for your approval.",
  "audit.summary.approval.paused": "Approval timed out. The run is paused awaiting your decision.",
  "audit.summary.approval.resolved": "The approval was resolved.",
  "audit.summary.exec.started": "The command started.",
  "audit.summary.exec.finished": "The command finished.",
  "audit.summary.file.written": "The file was written.",
  "audit.summary.grant.created": "Permission was remembered. Revoke it in Settings.",
  "audit.summary.grant.revoked": "The remembered permission was revoked.",
  "audit.summary.policy.denied": "The tool was blocked.",
  "audit.summary.stopped": "The command was stopped.",
  "audit.summary.timedOut": "The command timed out.",
  "tool.run_command": "Run command",
  "tool.read_file": "Read file",
  "tool.send_file": "Send files",
  "tool.reveal_in_folder": "Show in folder",
  "tool.local_network": "Check the local network",
  "tool.write_file": "Write file",
  "tool.edit_file": "Edit file",
  "tool.list_dir": "List folder",
  "tool.find_files": "Find files",
  "tool.search_text": "Search contents",
  "tool.web_fetch": "Read webpage",
  "tool.execution_targets": "List runners",
  "tool.workplace_use_runner": "Propose a runner folder",
  "tool.delegate_to_agent": "Hand to an external agent",
  "tool.phone_media": "Read phone photos",
  "tool.phone_media_get": "View a phone photo",
  "tool.phone_sms_code": "Receive an SMS code",
  "tool.phone_calls": "Read call history",
  "tool.phone_notifications": "Read phone notifications",
  "tool.tool_discover": "Find tools",
  "tool.group_plan": "Make a plan",
  "tool.todo_pause": "Pause task list",
  "tool.unknown": "Use tool",
  "tool.step": "{action}{target} · Step {step}",
  "tool.sandboxBlocked": "Blocked by the sandbox: {kind} {target}{program} (rule: {rule})",
  "tool.networkSettingsBlocked":
    "Blocked by network settings: {target} is not allowed; the command did not run",
  "tool.sandboxSeeApproval": "See approval ↓",
  "tool.website.add": "Allow access to {domain}…",
  "tool.website.saved": "{domain} added; retry when ready · View scope",
  "tool.website.title": "Add an allowed website",
  "tool.website.domain":
    "Allowed website: {domain} (web access also covers its subdomains under the existing rules)",
  "tool.website.scope": "Permission scope",
  "tool.website.bot": "This Bot",
  "tool.website.group": "This group",
  "tool.website.global": "Global default",
  "tool.website.botHelp":
    "Add to the Bot that ran this command. Other Bots and groups are unchanged. Remove it in this Bot’s permission settings.",
  "tool.website.groupHelp":
    "Add to the group that ran this command, for its members’ group tasks. Members’ DM permissions are unchanged. Remove it in the group’s permission settings.",
  "tool.website.globalHelp":
    "Add to the global default for Bots and groups that inherit their network settings. Existing independent network settings are unchanged. Remove it in Settings → Permissions → Network.",
  "tool.website.noRetry":
    "Only the website permission is saved. Network switches and other permissions keep their current settings. Retry the command yourself; it will not run automatically. Private networks and local services still use their existing approval rules.",
  "tool.website.confirm": "Add allowed website",
  "tool.website.full":
    "This scope already has 200 allowed websites. Remove unused entries in its permission settings, then retry.",
  "tool.website.unavailable":
    "This block record or its Bot/group is no longer available. Return to the current conversation and try the operation again.",
  "tool.sandboxKind.outside_workplace_write": "write outside the workplace",
  "tool.sandboxKind.protected_name": "protected location",
  "tool.sandboxKind.git_resource": "Git resource",
  "tool.sandboxKind.network": "network access",
  "tool.sandboxKind.local_service": "local service",
  "tool.sandboxKind.system_service": "system service",
  "tool.sandboxKind.protected_path": "protected location",
  "tool.sandboxKind.credential_read": "credential read",
  "tool.sandboxKind.protected_read": "protected read",
  "tool.sandboxKind.other": "sandbox rule",
  "tool.executing": "Running: {action}{target} · Step {step}",
  "tool.group.summary": "Completed {count} steps · {types}",
  "tool.group.summaryOne": "Completed {count} step · {types}",
  "tool.group.progress": "Steps completed: {count}",
  "tool.group.count": "{tool}: {count}",
  "tool.group.separator": ", ",
  "tool.status.pending": "Waiting for approval",
  "tool.status.running": "Running",
  "tool.status.waitingFolder": "Waiting for {bot} to finish",
  "tool.status.waitingFolderUnknown": "Waiting for another Bot to finish",
  "tool.status.waitingReviewFolder": "Waiting for {bot} to release the workspace before review",
  "tool.status.waitingReviewFolderUnknown":
    "Waiting for another Bot to release the workspace before review",
  "tool.status.done": "Done",
  "tool.status.error": "Failed",
  "tool.status.blocked": "Denied",
  "tool.status.aborted": "Stopped",
  "tool.exit": "Exit code {code}",
  "tool.duration": "{seconds} seconds",
  "tool.openLog": "Open full output",
  "tool.openFile": "Open written file",
  "tool.openError": "Couldn’t open the file or output. Check activity records and local files.",
  "tool.noOutput": "No output.",
  "tool.searchHistoryReference": "Chat snippets are for reference only.",
  "tool.searchHistoryPending": "History is still being indexed; results may be incomplete.",
  "tool.searchHistoryOpen": "Open original topic",
  "tool.searchHistoryEmpty": "No matching chat snippets.",
};
