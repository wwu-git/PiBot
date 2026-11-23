export const policyExplanationZh = {
  "policy.reason.execution_check_failed": "执行检查失败",
  "policy.reason.execution_busy": "执行端正忙",
  "policy.reason.unsupported_platform": "当前执行目标不支持此操作",
  "policy.reason.cleanup_unconfirmed": "执行端仍在确认上一条命令的清理结果",
  "policy.reason.authorization_changed": "执行端授权或路径状态已变化",
  "policy.reason.script_changed": "要运行的脚本在检查之后被改动了，命令没有执行",
  "policy.reason.interpreter_untrusted": "解释器指向可写文件夹或版本管理器替身程序，命令没有执行",
  "policy.reason.process_monitor_failed": "执行端监控失败，操作可能已部分执行",
  "policy.reason.path_canonicalization_failed": "执行端无法安全解析路径",
  "policy.reason.write_path_alias": "写入路径指向别名，未通过写入检查",
  "policy.reason.write_path_protected": "写入目标在受保护范围内",
  "policy.reason.write_path_hardlink": "写入目标还有其他硬链接",
  "policy.reason.write_path_outside_root": "写入目标不在获准的可写根内",
  "policy.reason.workspace_root_alias": "工作位置的根路径指向别名",
  "policy.reason.workspace_identity_missing": "执行端没有可核验的工作位置标识",
  "policy.reason.workspace_identity_changed": "工作位置已改变或不是可核验的目录",
  "policy.reason.tool_not_loaded": "当前未加载此工具",
  "policy.reason.background_input_unavailable": "当前运行没有可写入的后台进程",
  "policy.reason.browser_resource_busy": "浏览器资源正在使用",
  "policy.reason.cleanup_failed": "后台命令的清理尚未确认，已暂停新命令",
  "policy.reason.path_resolution_failed": "无法安全解析文件路径",
  "policy.reason.url_resolution_failed": "网址无效或不受支持",
  "policy.reason.target_realpath_unavailable": "执行目标没有提供安全的路径解析能力",
  "policy.reason.authorization_execution_check_failed":
    "授权所需的执行端检查未完成；本次工具调用未获授权",
  "policy.reason.execution_command_failed": "命令未完成；没有确认具体失败项",
  "policy.reason.execution_outside_workplace": "执行端的工作位置或路径边界检查未通过",
  "policy.reason.execution_file_sensitive": "执行端拒绝访问受保护的文件",
  "policy.reason.execution_file_access_denied": "执行端文件权限检查未通过",
  "policy.reason.execution_file_not_found": "执行端找不到检查所需的文件或目录",
  "policy.reason.execution_isolation_unavailable": "执行端无法确认所需的命令隔离",
  "policy.reason.execution_isolation_scan_limit": "执行端只读保护扫描达到上限",
  "policy.reason.execution_authorization_changed": "执行端授权或路径状态已变化",
  "policy.reason.execution_timeout": "执行端检查超时",
  "policy.reason.process_snapshot_timeout": "读取进程快照超时",
  "policy.reason.process_snapshot_failed": "读取进程快照失败",
  "policy.reason.process_snapshot_limit": "进程快照超出扫描上限",
  "policy.reason.profile_data_root": "命令隔离配置拒绝了应用数据根检查",
  "policy.reason.profile_bot_home": "命令隔离配置拒绝了 Bot 主目录检查",
  "policy.reason.profile_bot_skills": "命令隔离配置拒绝了 Bot 技能目录检查",
  "policy.reason.profile_bot_attachments": "命令隔离配置拒绝了 Bot 附件目录检查",
  "policy.reason.profile_group_skills": "命令隔离配置拒绝了群技能目录检查",
  "policy.reason.profile_group_home": "命令隔离配置拒绝了群主目录检查",
  "policy.reason.profile_skill_package": "命令隔离配置拒绝了技能包目录检查",
  "policy.reason.profile_skill_env": "命令隔离配置拒绝了技能环境目录检查",
  "policy.reason.profile_python_env": "命令隔离配置拒绝了 Python 环境目录检查",
  "policy.reason.profile_managed_python": "命令隔离配置拒绝了托管 Python 目录检查",
  "policy.reason.profile_uv_cache": "命令隔离配置拒绝了 uv 缓存目录检查",
  "policy.reason.profile_uv_binary": "命令隔离配置拒绝了 uv 程序路径检查",
  "policy.reason.profile_write_root": "命令隔离配置拒绝了可写根检查",
  "policy.reason.profile_temp_root": "命令隔离配置拒绝了临时根检查",
  "policy.reason.profile_read_root": "命令隔离配置拒绝了只读根检查",
  "policy.reason.profile_temp_namespace": "命令隔离配置拒绝了临时隔离目录检查",
  "facts.value.unknown_command_directory":
    "写入位置无法确定，且本次命令不在已确认的隔离沙箱内，需要逐次确认",
  "facts.value.unknown_command_directory_sandboxed":
    "写入位置无法确定，由隔离沙箱限制在工作位置内；本次确认不能记住或用于例行预授权",
  "policy.reason.project_notes_confirmation": "更新项目说明需要逐次确认（含新建文件）",
  "policy.reason.consent_scope_narrowed": "本次授权仅限当前操作，不能扩大记住范围",
  "policy.reason.readonly_isolation_required": "只读参考目录需要可用的命令隔离",
  "policy.reason.browser_sensitive_confirmation": "浏览器写请求或原值揭示需要逐次确认",
  "policy.reason.read_ai_config_once": "读取其他 AI 配置需要逐次确认",
  "policy.reason.bot_skill": "读取当前 Bot 自己的技能目录",
  "policy.reason.bot_attachment": "读取这条消息里的附件（当前 Bot 自己保存的文件）",
  "policy.reason.category_unavailable": "此操作没有可用的权限类别或目标",
  "policy.reason.connector_metadata": "只读取可见连接的工具信息",
  "policy.reason.connector_draft_only": "写操作只生成草稿，发送前仍需授权",
  "policy.reason.routine_preauth_unavailable": "当前操作不能建立例行预授权",

  "policy.reason.permission_never": "此类操作设为不允许",
  "policy.reason.permission_ask": "此类操作需要逐次确认",
  "policy.reason.permission_always": "此类操作设为总是允许",
  "policy.reason.group_output_write":
    "写入本群自己的输出目录（群计划步骤自己的输出目录也在这里），不需要逐次确认",
  "policy.reason.permission_level": "读取当前生效的权限设置",
  "policy.reason.outside_workplace": "目标在工作文件夹之外，授权范围已收窄",
  "policy.reason.inside_workplace": "目标位于已关联的工作文件夹",
  "policy.reason.outside_workplace_write_denied": "不能写入工作文件夹之外",
  "policy.reason.outside_workplace_write": "要写工作文件夹之外的路径，只能允许这一次",
  "policy.reason.protected_path":
    "根目录、主目录本身、系统目录、Pi Bot 数据目录和凭据位置始终不能写",
  "policy.reason.outside_workplace_send_denied": "附件不在当前可读取的工作范围内",
  "policy.reason.readonly_workplace": "只读参考文件夹不能写入",
  "policy.reason.workspace_readonly": "原保存位置不再允许写入",
  "policy.reason.workspace_snapshot": "按当前工作文件夹身份核验",
  "policy.reason.workplace_roots": "按已关联的工作文件夹核验",
  "policy.reason.sensitive_path": "受保护的位置不可读取",
  "policy.reason.read_ai_config": "读取其他 AI 工具的配置需要单独确认",
  "policy.reason.ai_config_requires_approval": "这次读取 AI 配置需要确认且不能记住授权",
  "policy.reason.invalid_workplace": "当前工作文件夹不可用",
  "policy.reason.path_or_url_unresolved": "无法安全确认目标位置",
  "policy.reason.domain_not_allowed": "目标网站不在允许范围内",
  "policy.reason.local_network_denied": "不能访问未授权的本机或内网地址",
  "policy.reason.invalid_image_recipient": "图片服务目标与当前配置不一致",
  "policy.reason.configured_image_service": "使用已配置的图片服务",
  "policy.reason.paid_generation_confirmation":
    "每次生成图片都会收费，需要你确认（YOLO 也不会自动放行）；可以选「这个 Bot 用这个模型不再问」",
  "policy.reason.configured_search_endpoint": "使用用户明确配置的搜索服务",
  "policy.reason.own_local_service": "仅访问本 Bot 当前运行的本机服务",
  "policy.reason.private_network_confirmation":
    "要访问你本地网络里的这个地址（路由器、局域网设备）。每个地址每次任务确认一次，不会记住",
  "policy.reason.private_network_run_approved": "这次任务里你已允许访问这个本地网络地址",
  "policy.reason.private_network_only": "ping 只能用于本地网络里的设备",
  "policy.reason.network_state_read": "只读取本机的网卡、路由、DNS 和 Wi-Fi 状态，不改任何设置",
  "policy.reason.dangerous_operation": "操作包含危险步骤，需要本次确认",
  "policy.reason.command_network_confirmation":
    "命令将访问包仓库以外的网络或未知目标，需要本次确认",
  "policy.reason.command_install_confirmation": "命令将安装或更新软件依赖，需要本次确认",
  "policy.reason.command_background_confirmation": "命令将在后台持续运行，需要本次确认",
  "policy.reason.sandboxed_command": "命令在隔离环境内运行，仅开放包仓库网络和已有写入范围",
  "policy.reason.privilege_escalation_denied": "不能提升系统权限",
  "policy.reason.incomplete_analysis": "命令无法完整分析，需要逐次确认",
  "policy.reason.windows_requires_approval": "当前 Windows 命令需要逐次确认",
  "policy.reason.windows_ordinary_command":
    "普通 Windows 命令仍需确认，除非已开启 YOLO 并同意无隔离执行",
  "policy.reason.windows_read_only": "已检查 Windows 命令的只读操作和读取范围",
  "policy.reason.command_home_unavailable": "无法确认目标终端的主目录，请使用绝对路径",
  "policy.reason.windows_unisolated": "命令没有系统隔离，需要单独确认",
  "policy.reason.outside_sandbox_once": "这条命令刚被沙箱拦截，要在沙箱外运行一次，需要你当场确认",
  "policy.reason.outside_sandbox_strict": "已开启严格沙箱，不能在沙箱外运行命令",
  "policy.reason.sandbox_outside_command":
    "这条命令在你设置的「固定在沙箱外运行」清单里，每次运行都需要你确认",
  "policy.reason.outside_sandbox_no_block": "只有同一条命令刚被沙箱拦截后，才能请求在沙箱外运行",
  "policy.reason.local_service": "需要连接本机服务；只允许指定文件夹、程序和端口",
  "policy.reason.local_service_once":
    "允许这个程序连接本机服务；只放行卡片上列出的端口或套接字，其他端口和外网仍拦",
  "policy.reason.outside_sandbox_unsupported":
    "这里不支持在沙箱外运行（远端、Docker、后台命令、只读参考文件夹或受控配方）",
  "policy.reason.runner_command_protection_unavailable":
    "无法读取远端设备的命令保护信息，请确认连接并更新 runner 后重试",
  "policy.reason.acp_editor_terminal_unisolated":
    "命令由编辑器终端直接执行，Pi Bot 无法证明其系统隔离，需要单独确认",
  "policy.reason.isolation_unavailable": "系统隔离不可用，不能执行命令",
  "policy.reason.grant_matched": "命中了当前有效的已记住授权",
  "policy.reason.grant_not_matched": "没有匹配的已记住授权",
  "policy.reason.grant_unavailable": "这次操作不能使用已记住授权",
  "policy.reason.confirmation_required": "本次操作需要确认",
  "policy.reason.current_policy_decision": "保留当前权限判定",
  "policy.reason.yolo": "当前对话的 YOLO 自动允许本次询问",
  "policy.reason.secret_yolo": "当前对话的 YOLO 允许本次密钥使用，不记住授权",
  "policy.reason.secret_grant_required": "本次密钥使用还没有获得授权",
  "policy.reason.secret_grant_matched": "所需密钥已有有效使用授权",
  "policy.reason.secret_connector_config": "这个连接配置里的令牌随连接一起使用，不再单独授权",
  "policy.reason.secret_write_out": "内容含密钥，不能写出或发送",
  "policy.reason.connector_unavailable": "当前连接不可用",
  "policy.reason.connector_tool_denied": "当前连接工具不可调用",
  "policy.reason.connector_confirmation_required": "这个连接要求每次确认，不能记住或自动放行",
  "policy.reason.connector_read_only_mode": "这个连接设为只读，写操作不会执行",
  "policy.reason.connector_access": "当前连接访问已获准",
  "policy.reason.connector_ask_before_use": "这个连接设为每次使用前确认",
  "policy.reason.connector_read": "这是已授权连接的只读操作",
  "policy.reason.connector_write_draft": "这里只创建草稿，发送仍需独立授权",
  "policy.reason.user_send_confirmation": "以你的身份发送需要你明确确认",
  "policy.reason.search_disclosure_required": "使用搜索服务前需同意发送查询词",
  "policy.reason.search_provider_disclosure_required": "这个搜索提供商尚未获得发送查询词的同意",
  "policy.reason.search_disclosed": "已同意向当前搜索服务发送查询词",
  "policy.reason.browser_no_page": "当前没有可操作的页面",
  "policy.reason.browser_local_file_unavailable": "只能打开工作位置内的 HTML / 图片 / PDF",
  "policy.reason.browser_login_no_account": "当前网站没有可用的已保存账号",
  "policy.reason.browser_login_first": "首次在此网站自动登录需要确认",
  "policy.reason.browser_login_choose": "有多个账号，需要你选择",
  "policy.reason.browser_login_run_approved": "本轮已确认这个网站的登录",
  "policy.reason.browser_site_approved": "本轮已确认这个网站的访问",
  "policy.reason.browser_submit": "提交网页表单需要独立确认",
  "policy.reason.computer_coordinates_need_grant": "截图坐标操作需要本轮专门授权",
  "policy.reason.computer_always_list": "目标应用在总是允许名单内",
  "policy.reason.computer_app_not_in_always_list": "目标应用尚未全部获得长期授权",
  "policy.reason.app_blocked": "目标应用在屏蔽名单内",
  "policy.reason.computer_run_grant": "本轮操作电脑的授权范围仍有效",
  "policy.reason.computer_grant_required": "操作电脑需要选择应用和本次授权范围",
  "policy.reason.routine_preauth": "这次操作匹配当前任务的预授权",
  "policy.reason.routine_preauth_eligible": "此操作可按精确范围预授权",
  "policy.reason.routine_preauth_valid": "预授权的权限和工作文件夹仍有效",
  "policy.reason.routine_preauth_matched": "预授权的操作范围匹配",
  "policy.reason.routine_preauth_not_matched": "预授权范围不匹配，仍需审批",
  "policy.reason.routine_resumed_allowed": "任务恢复时已消费本次允许决定",
  "policy.reason.routine_resumed_denied": "任务恢复时没有有效的允许决定",
  "policy.reason.group_permission_scope": "按此群的独立权限范围核验",
  "policy.reason.task_frozen_permissions": "子任务只能使用冻结权限与当前权限的交集",
  "policy.reason.plan_readonly": "当前为只读规划模式，不能执行此操作",
  "policy.reason.task_conversation_scope": "子任务只能读取父任务提供的对话范围",
  "policy.reason.changed": "目标、权限或运行身份已经变化",
  "policy.reason.workspace_folder_added": "用户已把文件夹加入工作范围，原请求已作废，请重试",
  "policy.reason.batch_file_consent": "附件批次逐项核验，本次授权不能记住",
  "policy.reason.search_read_list_consent": "搜索同时需要读取和列目录权限",
  "policy.reason.patch_batch_consent": "补丁每个目标都需核验，不扩大单文件授权",
  "policy.reason.managed_image_consent": "仅授权本次受管图片操作",
  "policy.reason.image_single_file_consent": "仅授权保存这一张图片，不记住目录权限",
  "policy.reason.connector_direct_write": "此 MCP 连接允许在聊天中直接写入",
  "policy.reason.draft_automatic_authorized": "当前草稿的自动发送授权仍有效",
  "policy.reason.draft_confirmation_required": "发送草稿还需要独立确认",
  "policy.reason.derived_consent_required": "派生操作需要单独确认",
  "policy.reason.approval_user_allowed": "你允许了这次操作",
  "policy.reason.approval_task_web_allowed": "本任务内已允许读取公开网页",
  "policy.reason.approval_user_denied": "你拒绝了这次操作",
  "policy.reason.approval_expired": "审批已过期，操作未获准",
  "policy.reason.approval_cancelled": "审批已取消，操作未获准",
  "policy.reason.remember_secret_checked": "记住前已复核密钥版本和授权范围",
  "policy.reason.remember_grant_checked": "记住前已复核授权范围",
  "policy.reason.docker_access": "本机 Docker 的高权限访问需要单独确认",
  "policy.reason.docker_permission_required": "本机 Docker 功能未开启",
  "policy.reason.docker_explicit_required": "命令必须明确申请 Docker 能力",
  "policy.reason.docker_unsupported": "当前运行不支持此 Docker 能力",
  "policy.reason.docker_network_unsupported": "当前网络名单不能约束 Docker 网络",
  "policy.reason.docker_command_invalid": "Docker 参数不符合专用通道要求",
  "policy.reason.docker_endpoint_unavailable": "已选择的 Docker 端点不可用",
  "policy.reason.docker_secret_unsupported": "Docker 通道不支持本次密钥注入",
  "policy.reason.background_routine": "无人值守任务不支持此后台进程",
  "policy.reason.background_limit": "这个话题同时运行的后台进程已达上限（每个话题 3 个）",
  "policy.reason.background_bot_limit": "这个 Bot 所有话题合计的后台进程已达上限（每个 Bot 8 个）",
  "policy.reason.message_scope_unavailable": "当前消息读取范围不可用",
  "policy.reason.scoped_tool_metadata": "只返回当前范围可用的工具信息",
  "policy.reason.plugin_install": "安装插件，保留文件与配置安全检查",
  "policy.reason.bot_owned_memory": "操作当前允许范围内的记忆",
  "policy.reason.memory_after_untrusted": "本轮读过网页、文件或其他不可信内容，保存记忆需要你确认",
  "policy.reason.memory_sensitive": "这条记忆可能包含密钥、证件号码或健康信息，需要你确认",
  "policy.reason.own_background_commands": "只管理本 Bot 自己的后台命令",
  "policy.reason.readonly_command": "工作位置里的只读命令，不联网、不改文件",
  "policy.reason.editor_terminal_readonly":
    "编辑器终端里的只读命令，只涉及本会话的工作文件夹，按「运行命令」权限直接运行",
  "policy.reason.editor_session_allowed": "你已在本次 ACP 会话里允许过同样的程序和参数",
  "policy.reason.editor_session_command": "你选择了本次会话都允许这类命令",
  "policy.reason.public_web_read": "这个 Bot 已一直允许读取公开网页",
  "policy.reason.run_grant_matched": "这次回复里你已允许过这个文件夹",
  "policy.reason.paid_grant_matched": "你已允许这个 Bot 用这个模型付费生成图片，不再询问",
  "policy.reason.routine_paid_preapproved": "这个例行任务已预授权用这个模型付费生成图片",
  "policy.reason.own_browser_tabs": "只查看或关闭 Bot 浏览器自己的标签页",
  "policy.reason.validated_group_collaboration": "群协作身份和范围已经核验",
  "policy.reason.user_confirmation_required": "此业务操作需要你的确认",
  "policy.reason.permission_narrowed": "当前权限比原授权更严格",
  "policy.reason.invalid_tool_input": "工具参数无效，不能执行",
  "policy.reason.tool_authorization_refused": "工具没有获得有效授权",
  "policy.reason.stopped": "运行已经停止",
  "policy.whyAsk": "为什么要审批：{reason}",
  "policy.whyDenied": "为什么被拒：{reason}",
  "policy.whyAllowed": "为什么获准：{reason}",
  "policy.details": "查看判定步骤",
  "policy.step": "{reason} · {effect}",
  "policy.level": "{source} · {level}",
  "policy.source.default": "全局默认",
  "policy.source.bot": "Bot 设置",
  "policy.source.group": "群设置",
  "policy.source.routine": "任务设置",
  "policy.level.always": "总是允许",
  "policy.level.ask": "询问",
  "policy.level.never": "不允许",
  "policy.effect.info": "核验",
  "policy.effect.narrow": "收窄范围",
  "policy.effect.allow": "允许",
  "policy.effect.ask": "需要确认",
  "policy.effect.deny": "拒绝",
  "policy.axis.category": "确认操作类别",
  "policy.axis.boundary": "核验安全边界",
  "policy.axis.grant": "核验授权范围",
  "policy.axis.level": "核验权限设置",
  "policy.axis.danger": "核验操作风险",
  "policy.axis.connector": "核验连接权限",
  "policy.axis.secret": "核验密钥权限",
  "policy.axis.yolo": "核验对话 YOLO 状态",
  "policy.axis.intrinsic": "核验自有资源范围",
} as const;

export const policyExplanationEn: Record<keyof typeof policyExplanationZh, string> = {
  "policy.reason.execution_check_failed": "An execution check failed",
  "policy.reason.execution_busy": "The execution target is busy",
  "policy.reason.unsupported_platform": "The execution target does not support this operation",
  "policy.reason.cleanup_unconfirmed":
    "The execution target is still confirming cleanup of the previous command",
  "policy.reason.authorization_changed": "The execution target authorization or path state changed",
  "policy.reason.script_changed": "The script changed after it was checked; nothing ran",
  "policy.reason.interpreter_untrusted":
    "The interpreter resolves to a writable folder or a version-manager shim; nothing ran",
  "policy.reason.process_monitor_failed":
    "Monitoring failed on the execution target; the operation may have partially run",
  "policy.reason.path_canonicalization_failed":
    "The execution target could not safely resolve the path",
  "policy.reason.write_path_alias": "The write path is an alias and did not pass the write check",
  "policy.reason.write_path_protected": "The write target is in a protected location",
  "policy.reason.write_path_hardlink": "The write target has other hard links",
  "policy.reason.write_path_outside_root":
    "The write target is outside the approved writable roots",
  "policy.reason.workspace_root_alias": "The workplace root path is an alias",
  "policy.reason.workspace_identity_missing":
    "The execution target has no workplace identity to verify",
  "policy.reason.workspace_identity_changed":
    "The workplace changed or is not a verifiable directory",
  "policy.reason.tool_not_loaded": "This tool is not loaded",
  "policy.reason.background_input_unavailable":
    "No background process is available for input in this run",
  "policy.reason.browser_resource_busy": "The browser resource is busy",
  "policy.reason.cleanup_failed":
    "Background command cleanup is unconfirmed; new commands are paused",
  "policy.reason.path_resolution_failed": "The file path could not be safely resolved",
  "policy.reason.url_resolution_failed": "The website address is invalid or unsupported",
  "policy.reason.target_realpath_unavailable": "The execution target cannot safely resolve paths",
  "policy.reason.authorization_execution_check_failed":
    "An execution check needed for authorization did not complete; this tool call was not authorized",
  "policy.reason.execution_command_failed":
    "The command did not complete; the exact cause was not confirmed",
  "policy.reason.execution_outside_workplace":
    "The execution target rejected the workspace or path boundary",
  "policy.reason.execution_file_sensitive":
    "The execution target refused access to a protected file",
  "policy.reason.execution_file_access_denied": "The execution target refused filesystem access",
  "policy.reason.execution_file_not_found":
    "The execution target could not find the file or directory needed for the check",
  "policy.reason.execution_isolation_unavailable":
    "The execution target could not confirm the required command isolation",
  "policy.reason.execution_isolation_scan_limit":
    "The execution target reached the read-only protection scan limit",
  "policy.reason.execution_authorization_changed":
    "The execution target authorization or path state changed",
  "policy.reason.execution_timeout": "The execution target check timed out",
  "policy.reason.process_snapshot_timeout": "Reading the process snapshot timed out",
  "policy.reason.process_snapshot_failed": "Reading the process snapshot failed",
  "policy.reason.process_snapshot_limit": "The process snapshot exceeded its scan limit",
  "policy.reason.profile_data_root":
    "The command isolation profile rejected the application data root check",
  "policy.reason.profile_bot_home": "The command isolation profile rejected the Bot home check",
  "policy.reason.profile_bot_skills":
    "The command isolation profile rejected the Bot skills directory check",
  "policy.reason.profile_bot_attachments":
    "The command isolation profile rejected the Bot attachments directory check",
  "policy.reason.profile_group_skills":
    "The command isolation profile rejected the group skills directory check",
  "policy.reason.profile_group_home": "The command isolation profile rejected the group home check",
  "policy.reason.profile_skill_package":
    "The command isolation profile rejected the skill package directory check",
  "policy.reason.profile_skill_env":
    "The command isolation profile rejected the skill environment directory check",
  "policy.reason.profile_python_env":
    "The command isolation profile rejected the Python environment directory check",
  "policy.reason.profile_managed_python":
    "The command isolation profile rejected the managed Python directory check",
  "policy.reason.profile_uv_cache":
    "The command isolation profile rejected the uv cache directory check",
  "policy.reason.profile_uv_binary":
    "The command isolation profile rejected the uv executable path check",
  "policy.reason.profile_write_root":
    "The command isolation profile rejected the writable root check",
  "policy.reason.profile_temp_root":
    "The command isolation profile rejected the temporary root check",
  "policy.reason.profile_read_root":
    "The command isolation profile rejected the read-only root check",
  "policy.reason.profile_temp_namespace":
    "The command isolation profile rejected the private temporary directory check",
  "facts.value.unknown_command_directory":
    "The write location is unknown and this command has no confirmed sandbox; approve this call individually",
  "facts.value.unknown_command_directory_sandboxed":
    "The write location is unknown; the sandbox restricts writes to the working folders. This approval cannot be remembered or used for routine preauthorization",
  "policy.reason.project_notes_confirmation":
    "Project instructions require confirmation for every write, including creation",
  "policy.reason.consent_scope_narrowed":
    "Consent is limited to this operation and cannot widen remembered access",
  "policy.reason.readonly_isolation_required":
    "Readonly reference folders require command isolation",
  "policy.reason.browser_sensitive_confirmation":
    "Browser writes and secret reveals require confirmation each time",
  "policy.reason.read_ai_config_once":
    "Reading other AI configuration requires confirmation each time",
  "policy.reason.bot_skill": "Reading this Bot’s own skill directory",
  "policy.reason.bot_attachment": "Reading an attachment of this message (saved by this Bot)",
  "policy.reason.category_unavailable":
    "This operation has no available permission category or target",
  "policy.reason.connector_metadata": "Reading tool metadata from a visible connection",
  "policy.reason.connector_draft_only":
    "This write only creates a draft; sending still requires authorization",
  "policy.reason.routine_preauth_unavailable":
    "This operation cannot establish routine preauthorization",

  "policy.reason.permission_never": "This operation is set to Never",
  "policy.reason.permission_ask": "This operation requires approval",
  "policy.reason.permission_always": "This operation is set to Always allow",
  "policy.reason.group_output_write":
    "Writes into this group's own output folder (which also holds each plan step's own output folder) do not need a per-file approval",
  "policy.reason.permission_level": "Read the effective permission settings",
  "policy.reason.outside_workplace":
    "The target is outside the working folders; permission is narrowed",
  "policy.reason.inside_workplace": "The target is inside an associated working folder",
  "policy.reason.outside_workplace_write_denied":
    "Writing outside the working folders is prohibited",
  "policy.reason.outside_workplace_write":
    "This writes outside the working folders and can only be allowed once",
  "policy.reason.protected_path":
    "The filesystem root, the home folder itself, system folders, Pi Bot data and credential stores can never be written",
  "policy.reason.outside_workplace_send_denied":
    "The attachment is outside the readable working folders",
  "policy.reason.readonly_workplace": "Reference folders are read-only",
  "policy.reason.workspace_readonly": "The original save location is no longer writable",
  "policy.reason.workspace_snapshot": "Check the current working folder identity",
  "policy.reason.workplace_roots": "Check associated working folders",
  "policy.reason.sensitive_path": "Protected locations cannot be read",
  "policy.reason.read_ai_config": "Reading another AI tool configuration requires separate consent",
  "policy.reason.ai_config_requires_approval":
    "This AI configuration read needs approval and cannot be remembered",
  "policy.reason.invalid_workplace": "The current working folders are unavailable",
  "policy.reason.path_or_url_unresolved": "The target could not be safely resolved",
  "policy.reason.domain_not_allowed": "The website is outside the allowed scope",
  "policy.reason.local_network_denied": "Unapproved local or private network access is prohibited",
  "policy.reason.invalid_image_recipient":
    "The image service target does not match its configuration",
  "policy.reason.configured_image_service": "Use the configured image service",
  "policy.reason.paid_generation_confirmation":
    "Every image generation is billed, so it needs your confirmation (YOLO doesn’t skip it); you can choose “Don’t ask again for this Bot with this model”",
  "policy.reason.configured_search_endpoint": "Use the explicitly configured search service",
  "policy.reason.own_local_service": "Access only this Bot's live local service",
  "policy.reason.private_network_confirmation":
    "Reach this address on your local network (a router or a device on your LAN). Asked once per address and task, never remembered",
  "policy.reason.private_network_run_approved":
    "You allowed this local-network address earlier in this task",
  "policy.reason.private_network_only": "ping only reaches devices on the local network",
  "policy.reason.network_state_read":
    "Only reads this computer's interfaces, routes, DNS and Wi-Fi state; changes no settings",
  "policy.reason.dangerous_operation": "This operation contains risky steps and needs approval",
  "policy.reason.command_network_confirmation":
    "The command accesses a non-package or unknown network target and needs approval for this call",
  "policy.reason.command_install_confirmation":
    "Installing or updating software dependencies needs approval for this call",
  "policy.reason.command_background_confirmation":
    "Starting a command that keeps running in the background needs approval for this call",
  "policy.reason.sandboxed_command":
    "The command runs in isolation with package-repository access and existing write boundaries",
  "policy.reason.privilege_escalation_denied": "System privilege escalation is prohibited",
  "policy.reason.incomplete_analysis": "The command cannot be fully analyzed and needs approval",
  "policy.reason.windows_requires_approval": "This Windows command needs approval",
  "policy.reason.windows_ordinary_command":
    "This Windows command needs approval unless YOLO and consent to unisolated commands are both enabled",
  "policy.reason.windows_read_only":
    "Windows command checked for read-only operations and file access",
  "policy.reason.command_home_unavailable":
    "Target terminal home is unverified; use an absolute path",
  "policy.reason.windows_unisolated": "The command is not isolated and needs separate consent",
  "policy.reason.outside_sandbox_once":
    "This command was just blocked by the sandbox; running it once outside the sandbox needs your confirmation now",
  "policy.reason.outside_sandbox_strict":
    "Strict sandbox is on; commands cannot run outside the sandbox",
  "policy.reason.sandbox_outside_command":
    "This command is on your list of commands that run outside the sandbox; each run needs your confirmation",
  "policy.reason.outside_sandbox_no_block":
    "Running outside the sandbox is only available right after the same command was blocked by it",
  "policy.reason.local_service":
    "A local service connection is required; only the specified folder, program and port are allowed",
  "policy.reason.local_service_once":
    "Allow this program to connect to a local service; only the port or socket listed on the card opens, other ports and the internet stay blocked",
  "policy.reason.outside_sandbox_unsupported":
    "Running outside the sandbox is unavailable here (remote, Docker, background, read-only reference folders or a controlled recipe)",
  "policy.reason.runner_command_protection_unavailable":
    "Command protection information is unavailable; check the connection and update the runner before retrying",
  "policy.reason.acp_editor_terminal_unisolated":
    "The command runs directly in the editor terminal; Pi Bot cannot verify its system isolation, so separate consent is required",
  "policy.reason.isolation_unavailable": "Command isolation is unavailable; execution is refused",
  "policy.reason.grant_matched": "A valid remembered permission matches",
  "policy.reason.grant_not_matched": "No remembered permission matches",
  "policy.reason.grant_unavailable": "Remembered permission is unavailable for this operation",
  "policy.reason.confirmation_required": "This operation requires confirmation",
  "policy.reason.current_policy_decision": "Keep the current permission decision",
  "policy.reason.yolo": "YOLO in this conversation automatically allows this approval",
  "policy.reason.secret_yolo": "YOLO permits this secret use without remembering permission",
  "policy.reason.secret_grant_required": "This secret use has not been authorized",
  "policy.reason.secret_grant_matched": "Valid permission covers the required secret use",
  "policy.reason.secret_connector_config":
    "Tokens in this connection's configuration are used with the connection, without a separate permission",
  "policy.reason.secret_write_out": "Content contains a secret and cannot be written or sent",
  "policy.reason.connector_unavailable": "The connection is unavailable",
  "policy.reason.connector_tool_denied": "The connection tool is unavailable",
  "policy.reason.connector_confirmation_required":
    "This connection requires confirmation every time; automatic approval is disabled",
  "policy.reason.connector_read_only_mode":
    "This connection is read only; write operations are not run",
  "policy.reason.connector_access": "Connection access is authorized",
  "policy.reason.connector_ask_before_use": "This connection requires approval before each use",
  "policy.reason.connector_read": "This is a read-only operation on an authorized connection",
  "policy.reason.connector_write_draft":
    "This only creates a draft; sending needs separate authorization",
  "policy.reason.user_send_confirmation": "Sending as you requires your explicit confirmation",
  "policy.reason.search_disclosure_required":
    "Sending queries to the search service requires consent",
  "policy.reason.search_provider_disclosure_required":
    "Sending queries to this search provider has not been approved",
  "policy.reason.search_disclosed": "Sending queries to this search service has been approved",
  "policy.reason.browser_no_page": "There is no active page to operate",
  "policy.reason.browser_local_file_unavailable":
    "Only HTML, images and PDF files within the workplace can be opened",
  "policy.reason.browser_login_no_account": "No saved account is available for this site",
  "policy.reason.browser_login_first": "The first automatic login to this site requires approval",
  "policy.reason.browser_login_choose": "Multiple accounts are available; you must choose one",
  "policy.reason.browser_login_run_approved": "Login to this site was approved in this run",
  "policy.reason.browser_site_approved": "Access to this site was approved in this run",
  "policy.reason.browser_submit": "Submitting this web form requires separate approval",
  "policy.reason.computer_coordinates_need_grant": "Coordinate input requires a specific run grant",
  "policy.reason.computer_always_list": "The target apps are on the Always allow list",
  "policy.reason.computer_app_not_in_always_list": "Not all target apps have standing permission",
  "policy.reason.app_blocked": "A target app is blocked",
  "policy.reason.computer_run_grant": "The computer grant for this run remains valid",
  "policy.reason.computer_grant_required": "Computer use requires choosing apps and the run scope",
  "policy.reason.routine_preauth": "This operation matches the routine's preauthorization",
  "policy.reason.routine_preauth_eligible":
    "This operation is eligible for scoped preauthorization",
  "policy.reason.routine_preauth_valid":
    "Preauthorization permissions and working folders remain valid",
  "policy.reason.routine_preauth_matched": "The preauthorized operation scope matches",
  "policy.reason.routine_preauth_not_matched":
    "Preauthorization does not match; approval is still required",
  "policy.reason.routine_resumed_allowed": "The resumed task consumed this approval",
  "policy.reason.routine_resumed_denied": "The resumed task has no valid approval",
  "policy.reason.group_permission_scope": "Use this group's independent permission scope",
  "policy.reason.task_frozen_permissions":
    "A subtask uses the intersection of frozen and current permissions",
  "policy.reason.plan_readonly": "Read-only Plan mode does not permit this operation",
  "policy.reason.task_conversation_scope":
    "A subtask may only read conversation references supplied by its parent",
  "policy.reason.changed": "The target, permissions or run identity changed",
  "policy.reason.workspace_folder_added":
    "The user added a writable folder; the original request is invalid. Retry with a new tool call",
  "policy.reason.batch_file_consent":
    "Each attachment is checked; this batch permission cannot be remembered",
  "policy.reason.search_read_list_consent":
    "Search requires both read and directory-list permissions",
  "policy.reason.patch_batch_consent":
    "Every patch target is checked without widening file permission",
  "policy.reason.managed_image_consent": "Permission covers only this managed image operation",
  "policy.reason.image_single_file_consent":
    "Permission covers this image save without remembering folder access",
  "policy.reason.connector_direct_write": "This MCP connection allows direct writes in chats",
  "policy.reason.draft_automatic_authorized":
    "Automatic sending permission for this draft remains valid",
  "policy.reason.draft_confirmation_required": "Sending this draft requires separate approval",
  "policy.reason.derived_consent_required": "The derived operation requires separate consent",
  "policy.reason.approval_user_allowed": "You approved this operation",
  "policy.reason.approval_task_web_allowed": "Public web reads are already allowed for this task",
  "policy.reason.approval_user_denied": "You denied this operation",
  "policy.reason.approval_expired": "Approval expired; the operation was not authorized",
  "policy.reason.approval_cancelled": "Approval was cancelled; the operation was not authorized",
  "policy.reason.remember_secret_checked":
    "Secret versions and scope were rechecked before remembering",
  "policy.reason.remember_grant_checked": "The permission scope was rechecked before remembering",
  "policy.reason.docker_access": "Privileged local Docker access needs separate consent",
  "policy.reason.docker_permission_required": "Local Docker access is disabled",
  "policy.reason.docker_explicit_required": "The command must explicitly request Docker access",
  "policy.reason.docker_unsupported": "Docker access is unsupported for this run",
  "policy.reason.docker_network_unsupported":
    "The current allowlist cannot constrain Docker networking",
  "policy.reason.docker_command_invalid": "Docker arguments are invalid for the dedicated channel",
  "policy.reason.docker_endpoint_unavailable": "The selected Docker endpoint is unavailable",
  "policy.reason.docker_secret_unsupported":
    "This Docker channel does not support secret injection",
  "policy.reason.background_routine": "This background process is unavailable to unattended runs",
  "policy.reason.background_limit":
    "This topic has reached its background process limit (3 per topic)",
  "policy.reason.background_bot_limit":
    "This Bot has reached its background process limit across topics (8 per Bot)",
  "policy.reason.message_scope_unavailable": "The message-read scope is unavailable",
  "policy.reason.scoped_tool_metadata": "Return only tool metadata available in the current scope",
  "policy.reason.plugin_install": "Install a plugin with file and configuration safety checks",
  "policy.reason.bot_owned_memory": "Operate on memory within the current permitted scope",
  "policy.reason.memory_after_untrusted":
    "This run read a page, file or other untrusted content. Confirm before saving memory.",
  "policy.reason.memory_sensitive":
    "This memory may contain credentials, an identity number or health information. Your confirmation is required.",
  "policy.reason.own_background_commands": "Manage only this Bot's own background commands",
  "policy.reason.readonly_command":
    "A read-only command in a working folder: no network, no file changes",
  "policy.reason.editor_terminal_readonly":
    "A read-only command in the editor terminal touching only this session's folders; it runs under the run-command permission",
  "policy.reason.editor_session_allowed":
    "You already allowed this program and arguments in this ACP session",
  "policy.reason.editor_session_command": "You allowed this kind of command for this session",
  "policy.reason.public_web_read": "This Bot is always allowed to read public web pages",
  "policy.reason.run_grant_matched": "You already allowed this folder in this reply",
  "policy.reason.paid_grant_matched":
    "You allowed this Bot to generate paid images with this model without asking",
  "policy.reason.routine_paid_preapproved":
    "This routine is pre-approved to generate paid images with this model",
  "policy.reason.own_browser_tabs": "Only lists or closes the Bot browser’s own tabs",
  "policy.reason.validated_group_collaboration":
    "Group collaboration identity and scope have been checked",
  "policy.reason.user_confirmation_required": "This operation requires your confirmation",
  "policy.reason.permission_narrowed":
    "Current permissions are narrower than the original authorization",
  "policy.reason.invalid_tool_input": "Invalid tool arguments prevent execution",
  "policy.reason.tool_authorization_refused": "The tool has no valid authorization",
  "policy.reason.stopped": "The run has been stopped",
  "policy.whyAsk": "Why approval is needed: {reason}",
  "policy.whyDenied": "Why it was refused: {reason}",
  "policy.whyAllowed": "Why it was allowed: {reason}",
  "policy.details": "Show decision steps",
  "policy.step": "{reason} · {effect}",
  "policy.level": "{source} · {level}",
  "policy.source.default": "Global default",
  "policy.source.bot": "Bot settings",
  "policy.source.group": "Group settings",
  "policy.source.routine": "Routine settings",
  "policy.level.always": "Always allow",
  "policy.level.ask": "Ask",
  "policy.level.never": "Never",
  "policy.effect.info": "Checked",
  "policy.effect.narrow": "Scope narrowed",
  "policy.effect.allow": "Allowed",
  "policy.effect.ask": "Needs approval",
  "policy.effect.deny": "Refused",
  "policy.axis.category": "Check the operation category",
  "policy.axis.boundary": "Check safety boundaries",
  "policy.axis.grant": "Check permission scope",
  "policy.axis.level": "Check permission settings",
  "policy.axis.danger": "Check operation risk",
  "policy.axis.connector": "Check connection permission",
  "policy.axis.secret": "Check secret permission",
  "policy.axis.yolo": "Check conversation YOLO state",
  "policy.axis.intrinsic": "Check owned resources",
};
