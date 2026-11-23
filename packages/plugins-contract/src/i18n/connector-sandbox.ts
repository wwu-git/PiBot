// The run-as-me switch and start-failure reasons of local stdio MCPs.
export const connectorSandboxZh = {
  "connectors.nativeConfirmationTimedOut":
    "系统确认已超时并取消。请重新操作，并在 5 分钟内完成确认。",
  "connectors.nativeConfirmationWaiting": "请在系统对话框里确认。如果已有确认框打开，请先处理它。",
  "connectors.startFailure.reason.command_not_found_windows":
    "找不到或无法运行它的命令。请先安装所需程序，检查 PATH 和程序安装位置；也可以在「设置 → 权限 → 命令环境」加上程序所在的文件夹，再重启连接。",
  "connectors.importReason.manifest_not_found":
    "找不到插件清单、MCP 配置或可导入的技能。请选择插件的根文件夹。",
  "connectors.importReason.mcp_duplicate":
    "插件里重复声明了同名 MCP。请在来源配置中去掉重复项后重试。",
  "connectors.importReason.path_outside_plugin":
    "插件引用的文件超出了插件文件夹。请修正来源中的相对路径。",
  "connectors.importReason.file_too_large": "插件文件超过导入大小上限。请缩小文件后重试。",
  "connectors.importReason.layout_unsupported":
    "插件格式或目录结构不受支持，或来源在读取时发生了变化。请检查插件清单后重新选择。",
  "connectors.sourceDetails.before": "改动前",
  "connectors.sourceDetails.after": "改动后",
  "connectors.sourceDetails.command": "启动命令",
  "connectors.sourceDetails.arguments": "参数（展开查看）",
  "connectors.sourceDetails.envNames": "环境变量名（不显示值）",
  "connectors.sourceDetails.websites": "允许访问的网站",
  "connectors.sourceDetails.files": "插件文件",
  "connectors.sourceDetails.added": "新增",
  "connectors.sourceDetails.removed": "移除",
  "connectors.sourceDetails.truncated": "清单较长，只显示前 300 个新增和前 300 个移除的文件。",

  "connectors.audit.network": "已修改连接允许访问的网站",
  "connectors.startup.cwd": "工作目录：{cwd}",
  "connectors.startup.timeout": "启动超时：{seconds} 秒",
  "connectors.network.title": "允许访问的网站",
  "connectors.network.note":
    "每行一个网站域名，最多 64 个，不含 https:// 或路径。保存后会重启连接；在沙箱外运行时仍可访问任何网络。远程 MCP 的连接地址必须在清单里，这不限制远程服务器自己的联网。配置变化后需要重新确认沙箱外运行。",
  "connectors.network.invalid": "请输入有效的网站域名，最多 64 个。",
  "connectors.network.save": "保存网站设置",
  "connectors.audit.outsideSandboxOn": "已设置本机 MCP 在沙箱外运行（以你的身份）",
  "connectors.audit.outsideSandboxOff": "本机 MCP 已回到沙箱里运行",
  "connectors.outsideSandbox.badge": "在沙箱外运行",
  "connectors.outsideSandbox.title": "沙箱",
  "connectors.outsideSandbox.switch": "在沙箱外运行（以你的身份）",
  "connectors.outsideSandbox.note":
    "默认在沙箱里运行：看不到你的文件、钥匙串和登录凭据，只能连它声明过的网站。打开后它以你的身份运行，能访问你所有的文件、钥匙串和凭据、任何网络和任何程序。打开时会弹出系统对话框请你确认；Bot 调用它的工具仍按上面的确认方式询问并记录。",
  "connectors.secureStorageBusy": "系统安全存储暂时繁忙。请处理系统授权提示后重试。",
  "connectors.secureStorageUnavailable":
    "无法访问系统安全存储。请解锁系统钥匙串，并在系统提示时允许 Pi Bot 访问。",
  "connectors.outsideSandbox.cancelled": "已取消，它仍在沙箱里运行。",
  "connectors.outsideSandbox.enabled": "已选择在沙箱外运行。关掉此选项可切回沙箱模式。",
  "connectors.outsideSandbox.on": "正以你的身份运行，没有沙箱隔离。关掉后回到沙箱里运行。",
  "connectors.outsideSandbox.reconfirm":
    "这个 MCP 的配置变了，之前的确认已失效。先关掉再打开，重新确认一次。",
  "connectors.outsideSandbox.suggest.ai_config_path":
    "它的命令在另一个 AI 工具的设置文件夹里（例如 ~/.codex、~/.claude），沙箱看不到那里，在沙箱里多半启动不了。如果你信任它，可以让它在沙箱外运行。",
  "connectors.outsideSandbox.suggest.sandbox_start_failed":
    "它在沙箱里没能启动。如果它需要你的钥匙串、登录或本机工具，而你信任它，可以让它在沙箱外运行。",
  "connectors.startFailure.title": "没能启动的原因",
  "connectors.startFailure.reason.sandbox_start_failed": "沙箱没能启动这个 MCP。",
  "connectors.startFailure.reason.sandbox_denied": "沙箱挡住了它需要的东西，它因此没能启动。",
  "connectors.startFailure.reason.command_not_found":
    "找不到或无法运行它的命令。如果这个程序装在 Homebrew、~/.local/bin、nvm 这类文件夹里，到「设置 → 权限 → 命令环境」加上那个文件夹（可以从终端环境导入），再重启连接；不然先安装它需要的程序。",
  "connectors.startFailure.reason.password_prompt":
    "这个 MCP 想在终端里要密码，但这里没有终端可以输入。请在「终端」里运行一次它的登录命令，然后重启连接。",
  "connectors.startFailure.reason.login_required":
    "这个 MCP 说要先登录。请在「终端」里运行一次它的登录命令，然后重启连接。",
  "connectors.startFailure.reason.dependency_missing":
    "它启动时缺少需要的模块，或者装上的依赖版本和它不兼容（下面「错误输出」里有具体是哪个）。请在它的来源配置里改好依赖（例如给版本加上限），再重新带过来或重启连接。",
  "connectors.startFailure.reason.timeout": "它在规定时间内没有应答。",
  "connectors.startFailure.reason.exited":
    "它启动后就退出了。展开下面的「错误输出」可以看到它说了什么。",
  "connectors.startFailure.reason.protocol_error": "它在运行，但没有按 MCP 协议应答。",
  "connectors.startFailure.reason.outside_sandbox_reconfirm":
    "配置变了，需要重新确认在沙箱外运行，所以没有启动。",
  "connectors.startFailure.reason.unknown": "启动失败，原因不明。",
  "connectors.startFailure.loginHint":
    "这类脚本通常有单独的登录命令：把它启动命令里的 run 换成 login（或先看它的 --help），在终端里运行一次。登录信息存好后，再打开这里的连接。",
  "connectors.startFailure.exitCode": "退出码 {code}",
  "connectors.startFailure.signal": "被 {signal} 结束",
  "connectors.startFailure.timedOut": "超时",
  "connectors.startFailure.where.sandbox": "在沙箱里",
  "connectors.startFailure.where.outside": "在沙箱外",
  "connectors.startFailure.denials": "沙箱拒绝了：",
  "connectors.startFailure.denial.credential_read": "读取登录信息 {target}",
  "connectors.startFailure.denial.protected_read": "读取受保护的位置 {target}",
  "connectors.startFailure.denial.keychain": "钥匙串",
  "connectors.startFailure.denial.system_service": "系统服务 {target}",
  "connectors.startFailure.denial.network": "连接 {target}",
  "connectors.startFailure.denial.other": "{target}",
  "connectors.startFailure.stderr": "它最后的输出（已隐去密钥）",
  "connectors.startFailure.restartToSee": "重启这个连接，就能看到这次没启动的原因。",
} as const;

export const connectorSandboxEn: Record<keyof typeof connectorSandboxZh, string> = {
  "connectors.nativeConfirmationTimedOut":
    "The system confirmation timed out and was cancelled. Try again and confirm within 5 minutes.",
  "connectors.nativeConfirmationWaiting":
    "Please confirm in the system dialog. If a confirmation dialog is already open, answer it first.",
  "connectors.startFailure.reason.command_not_found_windows":
    "The command was not found or could not run. Install the required program and check PATH and its installation location, or add its folder in Settings → Permissions → Command environment, then restart the connection.",
  "connectors.importReason.manifest_not_found":
    "No plugin manifest, MCP configuration or importable skill was found. Select the plugin root folder.",
  "connectors.importReason.mcp_duplicate":
    "The plugin declares the same MCP more than once. Remove the duplicate from its source configuration and try again.",
  "connectors.importReason.path_outside_plugin":
    "A referenced file is outside the plugin folder. Correct the relative path in the source.",
  "connectors.importReason.file_too_large":
    "A plugin file exceeds the import size limit. Reduce its size and try again.",
  "connectors.importReason.layout_unsupported":
    "The plugin format or folder layout is unsupported, or its source changed while being read. Check the manifest and select it again.",
  "connectors.sourceDetails.before": "Before",
  "connectors.sourceDetails.after": "After",
  "connectors.sourceDetails.command": "Command",
  "connectors.sourceDetails.arguments": "Arguments (expand to view)",
  "connectors.sourceDetails.envNames": "Environment variable names (values hidden)",
  "connectors.sourceDetails.websites": "Allowed websites",
  "connectors.sourceDetails.files": "Plugin files",
  "connectors.sourceDetails.added": "Added",
  "connectors.sourceDetails.removed": "Removed",
  "connectors.sourceDetails.truncated": "This list shows up to 300 added and 300 removed files.",

  "connectors.audit.network": "Connection allowed websites changed",
  "connectors.startup.cwd": "Working directory: {cwd}",
  "connectors.startup.timeout": "Startup timeout: {seconds} seconds",
  "connectors.network.title": "Allowed websites",
  "connectors.network.note":
    "One domain per line, up to 64, without https:// or paths. Saving restarts the connection. Outside the sandbox it can still access any network. A remote MCP endpoint must be listed; this does not restrict the remote server's own network. Configuration changes require confirming outside-sandbox execution again.",
  "connectors.network.invalid": "Enter valid website domains, up to 64.",
  "connectors.network.save": "Save website settings",
  "connectors.audit.outsideSandboxOn": "Local MCP set to run outside the sandbox (as you)",
  "connectors.audit.outsideSandboxOff": "Local MCP returned to the sandbox",
  "connectors.outsideSandbox.badge": "Runs outside the sandbox",
  "connectors.outsideSandbox.title": "Sandbox",
  "connectors.outsideSandbox.switch": "Run outside the sandbox (as you)",
  "connectors.outsideSandbox.note":
    "By default it runs in the sandbox: it cannot see your files, Keychain or saved logins, and can only reach the sites it declared. Turned on, it runs as you and can reach all your files, your Keychain and credentials, any network and any program. A system dialog asks you to confirm; a Bot's tool calls are still asked and recorded under the confirmation setting above.",
  "connectors.secureStorageBusy":
    "System secure storage is busy. Respond to any system authorization prompts, then retry.",
  "connectors.secureStorageUnavailable":
    "System secure storage is unavailable. Unlock your system keyring and allow Pi Bot access if prompted.",
  "connectors.outsideSandbox.cancelled": "Cancelled; it still runs in the sandbox.",
  "connectors.outsideSandbox.enabled":
    "Outside-sandbox mode is selected. Turn it off to return to sandbox mode.",
  "connectors.outsideSandbox.on":
    "Running as you, without the sandbox. Turn it off to return to the sandbox.",
  "connectors.outsideSandbox.reconfirm":
    "This MCP's configuration changed, so the earlier confirmation no longer applies. Turn it off and on again to confirm.",
  "connectors.outsideSandbox.suggest.ai_config_path":
    "Its command is inside another AI tool's settings folder (such as ~/.codex or ~/.claude), which the sandbox cannot see, so it will most likely not start in the sandbox. If you trust it, you can run it outside the sandbox.",
  "connectors.outsideSandbox.suggest.sandbox_start_failed":
    "It did not start in the sandbox. If it needs your Keychain, a login or local tools, and you trust it, you can run it outside the sandbox.",
  "connectors.startFailure.title": "Why it did not start",
  "connectors.startFailure.reason.sandbox_start_failed": "The sandbox could not start this MCP.",
  "connectors.startFailure.reason.sandbox_denied":
    "The sandbox blocked something it needs, so it did not start.",
  "connectors.startFailure.reason.command_not_found":
    "Its command was not found or cannot run. If the program lives in a folder such as Homebrew, ~/.local/bin or nvm, add that folder under Settings → Permissions → Command environment (you can import it from the terminal environment), then restart the connection. Otherwise install the program it needs first.",
  "connectors.startFailure.reason.password_prompt":
    "This MCP asks for a password in a terminal, and there is no terminal here to type it. Run its login once in Terminal, then restart the connection.",
  "connectors.startFailure.reason.login_required":
    "This MCP says you need to log in first. Run its login once in Terminal, then restart the connection.",
  "connectors.startFailure.reason.dependency_missing":
    "It is missing a module it needs, or the installed dependency version is incompatible with it (the error output below names which). Fix the dependency in its source configuration (for example, cap the version), then bring it over again or restart the connection.",
  "connectors.startFailure.reason.timeout": "It did not answer in time.",
  "connectors.startFailure.reason.exited":
    "It exited right after starting. Open the error output below to see what it said.",
  "connectors.startFailure.reason.protocol_error":
    "It is running but did not answer as an MCP server.",
  "connectors.startFailure.reason.outside_sandbox_reconfirm":
    "Its configuration changed, so running outside the sandbox needs a new confirmation; it was not started.",
  "connectors.startFailure.reason.unknown": "It failed to start for an unknown reason.",
  "connectors.startFailure.loginHint":
    "Scripts like this usually have a separate login command: replace run with login in its start command (or check its --help first) and run it once in Terminal. Once the login is saved, turn the connection on here again.",
  "connectors.startFailure.exitCode": "Exit code {code}",
  "connectors.startFailure.signal": "Ended by {signal}",
  "connectors.startFailure.timedOut": "Timed out",
  "connectors.startFailure.where.sandbox": "In the sandbox",
  "connectors.startFailure.where.outside": "Outside the sandbox",
  "connectors.startFailure.denials": "The sandbox refused:",
  "connectors.startFailure.denial.credential_read": "Reading login data {target}",
  "connectors.startFailure.denial.protected_read": "Reading a protected location {target}",
  "connectors.startFailure.denial.keychain": "Keychain",
  "connectors.startFailure.denial.system_service": "System service {target}",
  "connectors.startFailure.denial.network": "Connecting to {target}",
  "connectors.startFailure.denial.other": "{target}",
  "connectors.startFailure.stderr": "Its last output (secrets hidden)",
  "connectors.startFailure.restartToSee": "Restart this connection to see why it did not start.",
};
