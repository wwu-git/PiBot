# 14 · FAQ and troubleshooting

On this page:

- [About Pi Bot](#about-pi-bot)
- [Download and installation](#download-and-installation)
- [Models and keys](#models-and-keys)
- [Folders and commands](#folders-and-commands)
- [Approvals](#approvals)
- [Group chats](#group-chats)
- [Routines](#routines)
- [Runners and the phone](#runners-and-the-phone)
- [Other](#other)

## About Pi Bot

**What is Pi Bot?**
Pi Bot is a multi-Bot desktop app that runs on your own computer. It supports macOS, Windows and Linux, and its code is open source under Apache-2.0. Bots can work together in a group, handle files, review code changes and run routines. The desktop app works on its own, with optional Android and runner pairing. See [1 · Getting started](01-getting-started.md) and [6 · Group chats](06-groups.md).

**Can Pi Bot work entirely offline?**
Configure Ollama on the same computer to keep model requests on that machine. Features that use the internet, such as web search and connected external apps, still need a network connection. See [9 · Models and keys](09-models-and-keys.md#local-models-and-custom-gateways) and [13 · Privacy and security](13-privacy-and-security.md).

## Download and installation

**Which installer should I choose?**
Choose an installer from the [download page](https://pibot.space/en/download/). On a Mac, use Apple menu → About This Mac to check whether it uses Apple silicon or Intel. Choose EXE for Windows, DEB for Debian or Ubuntu (AppImage for other Linux distributions), and APK for Android. Install a runner on a computer that will only execute delegated work.

**macOS says it cannot verify Pi Bot. What should I do?**
Pi Bot has not been notarized by Apple yet. If you downloaded it from the official site and choose to proceed, try opening it once, then select **Open Anyway** under System Settings → Privacy & Security. See [1 · Install](01-getting-started.md#macos).

**What do I need to set up on first launch?**
A working model. The welcome flow offers a recommended route (OpenRouter in English, DeepSeek in Chinese), a ChatGPT plan, local Ollama and your own API key. See [1 · Getting started](01-getting-started.md#first-launch-the-welcome-flow) and [Troubleshoot a model connection](09-models-and-keys.md#troubleshoot-a-model-connection).

## Models and keys

**Save & test fails and says the key is invalid.**
Check that you copied the whole key (no extra spaces), that it belongs to this provider, and that the account still has balance or quota. A key just created in the provider's console can take a moment to become active. Paste the new key and **Save & test** again.

**Pi Bot can't reach the model provider.**
If your network needs a proxy, turn on **Use proxy** in Settings › General › Network proxy (or under **Need a proxy? Set up a network proxy** in the welcome flow), enter the address and click **Test connection**. Pi Bot never uses the system proxy on its own; if this computer is already using one, the address is filled in and takes effect once you turn the switch on.

**My ChatGPT plan says "Usage limit reached".**
The plan's allowance is used up for now. Manage usage in ChatGPT, or save an API key in Settings › Models & API keys › OpenAI and switch the Bot to a model from the **OpenAI** group.

**The work receipt shows the cost as "Unknown".**
Some providers and custom gateways don't publish pricing, so Pi Bot doesn't estimate and shows how many requests had no pricing.

## Folders and commands

**The Bot says it can't read or write a folder.**
By default Bots read and write only in the topic's working folder. Files outside it ask first; for regular use, make it the main folder, **Add writable folder…** or **Add read-only reference…** from the folder menu at the top of the chat (see [4 · Working folders and changes](04-folders-and-changes.md)). Files in read-only references can't be changed.

**The Bot can't run commands.**
Check in order:

1. Is Run commands set to **Never** in Settings › Permissions (or on this Bot's Permissions tab)?
2. Is there an unanswered approval card in the chat (a count on **Inbox**)?
3. Linux: are `bubblewrap` and `socat` installed? When they're missing the Bot shows the install command; install and retry.
4. The sandbox blocked the command: the Bot explains why and can ask you to confirm running it once outside the sandbox. With **Strict sandbox** on, that option isn't offered.
5. Windows: every command needs your approval and can't be set to Always, because Windows doesn't support command isolation yet.

**I can't open the local preview server.**
Background commands Bots start can only listen on 127.0.0.1. Use **Open … in Bot browser** on the background command card, or open the address from the card in your own browser.

## Approvals

**An approval card says it expired.**
Approvals in a chat pause the task after 10 minutes without an answer; routine approvals are denied automatically after 24 hours. Send a message to let the Bot continue, or use **Run now** on the routine.

**I clicked Always allow and want to take it back.**
Review and revoke it on the Permissions tab of that Bot's profile.

## Group chats

**A group step keeps showing "Waiting".**
It is waiting for earlier steps to finish, or for a check result or your confirmation. Open the **Tasks** panel to see which step and what it is waiting for; a step marked **Needs you** can be retried, skipped or reassigned. On Windows and Linux, and while the computer has no Git, steps that could run at the same time take turns in the group's folder, so later ones wait for the one before (see [6 · Group chats](06-groups.md#tasks-panel-and-plans)).

**What happens to a running command when I pause a group?**
A command running inside a step is stopped and progress is kept. After **Continue**, the Bot that picks up knows which command was cut off and reruns it. Background services (such as a local preview) aren't affected by the pause; to stop one, click **Stop** on its background command card (see [Pause and continue](06-groups.md#pause-and-continue)).

**Pi Bot says it needs to install Git.**
This card appears on macOS and Linux when Git isn't installed. Click **Install** and follow the prompts (Linux asks for an administrator password), or click **Not now** and group steps take turns instead. The Windows installer includes Git, so there's nothing to install there (see [4 · Git](04-folders-and-changes.md#git)).

## Routines

**A routine didn't run on time.**

- The computer was asleep: Settings › Routines › **Tasks missed while the computer sleeps** decides what happens (catch up, skip or ask).
- Pi Bot was quit completely: routines stop by default. Choose **After you quit Pi Bot: Keep running schedules** in Settings › Routines, or **Background only** in Settings › General › Startup so Pi Bot starts in the background when you sign in.
- **Pause after 7 days away** is on and you haven't opened Pi Bot for more than 7 days.
- The routine is disabled: check the switch on its card on the Routines page.

**A routine is stuck waiting for me.**
It's waiting for an approval. Handle it in the Inbox, or add **Preauthorizations for this routine**.

## Runners and the phone

**A runner shows as offline.**

- Make sure the machine is on and the runner is running: `pibot runner status`. On Linux you can also run `systemctl --user status pibot-runner`.
- Both ends must use the same relay, and **Allow paired devices to connect** must be on on the computer.
- The runner reconnects by itself when the network is back. While it's offline you can't pick its folders and steps waiting for it fail; retry once it's online, or switch to a local folder.

**The pairing code is invalid.**
Codes expire after 10 minutes and work once. Run `pibot runner pair` again on the runner and copy the whole code.

**The phone keeps showing "Computer offline".**
The computer must be on with Pi Bot running (closing the window is fine, quitting completely isn't), and **Allow paired devices to connect** must be on in Settings › Devices. If the phone uses a VPN, let Pi Bot bypass it, otherwise only the relay path works. Android battery saving can cut background connections: set the app's Battery setting to Unrestricted, or turn on **Stay connected**.

**A Bot doesn't reply while the computer is offline.**
That Bot doesn't have offline replies on, or its model can't run on the phone (subscription sign-ins, cloud provider credentials and custom request headers stay on the computer). Check on the computer under Settings › Devices › this phone › **When this computer is offline**.

## Other

**How do I change the language or use dark mode?**
Switch them right in your avatar menu, or in Settings › General › Language & appearance. The language setting changes menus and buttons only; Bots reply in the language you write to them in.

**Is Pi Bot still running after I close the window?**
Yes. It keeps running in the tray / menu bar and routines keep running. To quit completely, use **Quit completely** in the tray menu.

**Pi Bot says the system secret store is unavailable.**
Pi Bot encrypts keys with the system secret store. On Linux that needs a running keyring service (such as GNOME Keyring or KWallet); make sure you're in a desktop session, then restart Pi Bot.
