import {
  linuxAppImageRemedy,
  linuxUserNamespacePersistence,
  linuxUserNamespaceRemedies,
} from "@pibot/execution/isolation-remedy";

// Also used before Chromium starts: this dialog cannot rely on a renderer or saved preferences.
export const linuxStartupZh = {
  "linuxStartup.title": "Pi Bot 无法安全启动",
  "linuxStartup.intro": "Pi Bot 未启动；Chromium 进程沙箱必须保持开启。",
  "linuxStartup.flags":
    "启动参数要求关闭沙箱。请移除 --no-sandbox 等关闭沙箱的参数，执行 unset ELECTRON_DISABLE_SANDBOX，再打开 Pi Bot。",
  "linuxStartup.root": "请以普通用户启动 Pi Bot，不要使用 sudo 或 root。",
  "linuxStartup.clone": linuxUserNamespaceRemedies.linux_userns_disabled.zh,
  "linuxStartup.max": linuxUserNamespaceRemedies.linux_userns_limit_zero.zh,
  "linuxStartup.apparmor": linuxAppImageRemedy.zh,
  "linuxStartup.useDeb":
    "在 Ubuntu 24.04 及以上请改用 .deb 安装包：https://pibot.space/cn/download/ 。它安装到 /opt/Pi Bot，并自带 Pi Bot 的 AppArmor 配置，不需要改系统设置。",
  "linuxStartup.apparmorDeb":
    "Chromium 沙箱需要创建用户命名空间，本机的 AppArmor 限制了它（linux_userns_restricted），而安装包自带的 Pi Bot 配置没有生效。管理员可运行 sudo apparmor_parser -r /etc/apparmor.d/pi-bot；如果这个文件不存在（例如安装 Pi Bot 之后才装了 AppArmor），先确认已安装 apparmor，再运行 sudo apt install --reinstall pibot。然后重新打开 Pi Bot。不要用 --no-sandbox 绕过。",
  "linuxStartup.runtime":
    "Chromium 的实际沙箱探测未成功（sandbox_dependencies_or_runtime_unavailable）。请确认在普通用户的图形会话中运行（自动验收可用 xvfb-run），并检查终端中的系统启动错误；若配置了 AppArmor，请检查系统拒绝日志。不要用 --no-sandbox 绕过。",
  "linuxStartup.persistence": linuxUserNamespacePersistence.zh,
} as const;

export const linuxStartupEn = {
  "linuxStartup.title": "Pi Bot cannot start safely",
  "linuxStartup.intro": "Pi Bot has not started. Chromium's process sandbox must stay enabled.",
  "linuxStartup.flags":
    "The launch arguments disable sandboxing. Remove --no-sandbox and other sandbox-disabling arguments, run unset ELECTRON_DISABLE_SANDBOX, then reopen Pi Bot.",
  "linuxStartup.root": "Start Pi Bot as a regular user, without sudo or root.",
  "linuxStartup.clone": linuxUserNamespaceRemedies.linux_userns_disabled.en,
  "linuxStartup.max": linuxUserNamespaceRemedies.linux_userns_limit_zero.en,
  "linuxStartup.apparmor": linuxAppImageRemedy.en,
  "linuxStartup.useDeb":
    "On Ubuntu 24.04 and later, install the .deb package instead: https://pibot.space/en/download/ . It installs to /opt/Pi Bot with Pi Bot's own AppArmor profile and changes no system settings.",
  "linuxStartup.apparmorDeb":
    "Chromium's sandbox needs to create a user namespace, which AppArmor restricts on this computer (linux_userns_restricted), and the Pi Bot profile that came with the package is not in effect. An administrator can run sudo apparmor_parser -r /etc/apparmor.d/pi-bot; if that file is missing (for example, AppArmor was installed after Pi Bot), make sure apparmor is installed, then run sudo apt install --reinstall pibot. Then reopen Pi Bot. Do not bypass this with --no-sandbox.",
  "linuxStartup.runtime":
    "Chromium's actual sandbox probe did not succeed (sandbox_dependencies_or_runtime_unavailable). Run in a regular user's graphical session (automated acceptance can use xvfb-run), and check system startup errors in a terminal; if AppArmor is configured, check its system denial logs. Do not bypass this with --no-sandbox.",
  "linuxStartup.persistence": linuxUserNamespacePersistence.en,
} as const;
