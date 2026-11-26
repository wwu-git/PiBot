# Outbound connections

[中文](../zh/outbound-connections.md)

This page lists every network connection Pi Bot can make: the desktop app, the Android phone app and the runner. For each one it says who receives it, what is sent, when it happens, whether it is on by default, and how to turn it off. The list is taken from the source code (Pi Bot 0.0.3); when a change adds or changes a connection, this page changes in the same release.

## In short

- **No telemetry.** Pi Bot has no analytics, no usage tracking, no automatic crash reports and no Pi Bot account. Problem reports are only sent by you (see [Problem reports](#problem-reports)).
- **Your content stays on your computer.** Chats, files, memory, settings and keys are stored locally. Content leaves only for a service you picked for the work at hand: the model provider, the search service, the websites a Bot opens, and the apps and MCP servers you connect.
- **Pi Bot's own servers never receive your chats or files.** They are `pibot.space` (updates), `roles.pibot.space` (role library), `relay.pibot.space` (phone and runner relay, end-to-end encrypted) and `auth.pibot.space` (only for Gmail's Google sign-in).
- **Third-party components stay quiet.** The pi agent kernel inside Pi Bot runs with its model catalog download, version check and telemetry switched off, and the computer-use driver runs with its telemetry and update check switched off.

## Overview

| Connection | Receiver | On by default? |
|---|---|---|
| [Update checks](#update-checks) | `pibot.space` | Yes |
| [Role library](#role-library) | `roles.pibot.space` | Only when you use it |
| [Model providers](#model-providers) | The provider you configure | Only after you set up a model |
| [ChatGPT plan](#chatgpt-plan) | `auth.openai.com`, `api.openai.com` or `chatgpt.com` | When signing in, refreshing sign-in or using a signed-in model |
| [Web search](#web-search) | DuckDuckGo, Bing, Brave, Tavily or your SearXNG | Yes, asks on first use |
| [Websites Bots visit](#websites-bots-visit) | The sites themselves | Yes |
| [Commands Bots run](#commands-bots-run) | Package registries, your allowed sites, your SSH hosts | Yes, limited |
| [MCP servers and connected apps](#mcp-servers-and-connected-apps) | The services you connect | No |
| [Gmail](#gmail) (not released yet) | Google, `auth.pibot.space` | No |
| [Skills](#skills) | GitHub, PyPI, npm | Only when you import or prepare one |
| [External agents](#external-agents) | npm, then the agent's own vendor | No |
| [Phone and runners: relay](#relay) | `relay.pibot.space` or your own relay | No |
| [Phone and runners: direct connection](#direct-connection-stun) | `stun.cloudflare.com` (STUN) | Yes, once the relay is on |
| [Phone notifications](#phone-notifications) | Expo, Google Firebase | Only if the phone allows notifications |
| [Phone offline replies](#phone-offline-replies) | The model provider, from the phone | No |
| [Problem reports](#problem-reports) | GitHub, in your browser | Only when you click |
| [Other](#other) | Links you open, spell-check dictionaries, the sandbox doctor | See below |

Pi Bot's own servers are reached only over HTTPS or WSS. STUN is a small UDP query that carries no content.

## Pi Bot's own servers

### Update checks

- **Receiver:** `pibot.space` (`/updates/` for version information, `/downloads/` for the update itself).
- **What is sent:** an ordinary request for the latest version information. The User-Agent carries only the app version, the operating system and the CPU type, for example `PiBot/0.0.3 (darwin; arm64)`. The update library normally adds a persistent random ID; Pi Bot replaces it with a fixed all-zero value, so no request can be linked to one installation. The server counts checks per day by version and platform, and that count is the only thing it keeps. Like any web server it sees your IP address.
- **When:** about one minute after the app starts, then every four hours while it runs, and whenever you click **Check for updates**. An update is downloaded only when you click **Update**, and installed only when you restart or quit.
- **Default:** on, in the installed app.
- **To stop it:** there is no setting for automatic checks. They only ever read version information; if you want none at all, block `pibot.space` in your firewall and update by downloading new versions yourself.

**Android phone app (from 0.0.4).** The app sends a plain HTTPS GET to `https://pibot.space/updates/android.json` without account, device or installation identifiers. The server can see your IP address. Automatic checks are on by default and run at app startup, at most once a day. You can also check on demand from **Devices**. Offline mode skips these checks. The app downloads the APK from `pibot.space` only when you choose to download and install the update.

### Role library

- **Receiver:** `roles.pibot.space`.
- **What is sent:** requests for the signed list of roles and group templates, and for the packs you install. No cookie, account or identifier is sent. Pi Bot checks the list's signature against keys built into the app, and each pack's size and SHA-256 against the list, before using anything.
- **When:** only when you click **Check role library** or **Refresh role library**, install or update a role or template from it, or open a link to a role version your saved copy of the list doesn't have yet. Opening the role picker doesn't connect.
- **Default:** no request until you do one of these.
- **To stop it:** don't use the role library; the built-in roles and templates work without it.

The relay (`relay.pibot.space`) and `auth.pibot.space` are described under [Phone and runners](#phone-and-runners) and [Gmail](#gmail).

## Models

### Model providers

- **Receiver:** the provider you set up in Settings › Models & API keys: OpenAI, Anthropic, Google, DeepSeek, OpenRouter, a cloud platform (Amazon Bedrock, Azure, Google Vertex AI, Cloudflare), a custom gateway, and so on. Each Bot can use a different one.
- **What is sent:** what the model needs to reply: the conversation, the Bot's persona and instructions, the memories it uses, file excerpts and web content it has read, tool results, and the images you attach. Your API key goes only to that provider. Requests name the app as "Pi Bot" (with the address pibot.space) for the provider's app attribution; no user identifier is added. For providers that support it, Pi Bot asks for longer prompt caching (up to 24 hours on some OpenAI models, 1 hour on Anthropic), which makes replies faster and cheaper; the provider's own terms govern that cache.
- **Auxiliary model:** Context compaction, handoffs, translation, persona drafts, and extracting information from web pages or memories from conversations send the relevant content to the auxiliary model’s provider. By default this is the main model.
- **When:** every time a Bot replies or uses a model. **Save & test** sends one short test request; **Fetch models** asks that provider (or your custom address) for its model list. Cloud platforms also contact their sign-in service, for example `oauth2.googleapis.com` for Google Vertex AI.
- **OpenRouter model list:** **Refresh model list** on the OpenRouter page downloads OpenRouter's public model list from `openrouter.ai`, without your key.
- **Default:** nothing is sent until you set up a model.
- **To stop it:** use a local model. Ollama, LM Studio and vLLM run on your computer; Pi Bot talks to them at `127.0.0.1` and nothing leaves the machine. The welcome flow looks for Ollama at `127.0.0.1:11434`, which also stays on the machine.
- **Proxy:** if you enter a proxy in Settings › General › Network proxy, all provider traffic goes through it (except model servers on this computer). Pi Bot never picks up the system proxy by itself.

### ChatGPT plan

- **Receiver:** Both options use `auth.openai.com` for sign-in and token refresh. **ChatGPT plan** model requests go to `api.openai.com`. **ChatGPT (Codex sign-in)** model requests go to `chatgpt.com`.
- **What is sent:** You sign in on OpenAI’s website. When you use a model, the conversation content it needs goes directly to OpenAI. Sign-in tokens are encrypted on this computer.
- **When:** When you choose to sign in, use a signed-in model, or the app refreshes the sign-in.
- **To stop it:** Open the relevant subscription under **Models & API keys** and choose **Disconnect**. You can disconnect each sign-in separately.

## What Bots do while working

### Web search

- **Receiver:** the search service chosen in Settings › Models & API keys › Web search:
  - **No API key (automatic)**, the default: DuckDuckGo (`html.duckduckgo.com`), falling back to Bing (`cn.bing.com` or `www.bing.com`) when DuckDuckGo can't be reached.
  - **DuckDuckGo** or **Bing** on their own.
  - **Brave Search API** (`api.search.brave.com`) or **Tavily** (`api.tavily.com`), with your API key.
  - **Self-hosted SearXNG**: only the address you enter.
- **What is sent:** the search terms the Bot writes, plus your key for Brave or Tavily.
- **When:** when a Bot searches the web. The keyless services ask in the chat the first time.
- **To stop it:** set **Visit websites** to **Never** in Settings › Permissions (for all Bots or for one Bot). This also blocks web search.

### Websites Bots visit

- **Receiver:** the websites a Bot opens, in its own browser or by fetching a page.
- **What is sent:** ordinary web requests. The Bot's browser is separate from yours and has none of your browser's sign-ins; it signs in only where you sign in for it or with an account you saved, and the first automatic sign-in and first form submission on each site ask you. By default it can't open addresses on this computer or your private network.
- **Pi Bot's browser extension:** if you install it (Chrome, Edge or Firefox), a Bot can work in your own browser, with that browser's sign-ins. The extension talks to the desktop app only through the browser's local native messaging; it sends nothing to Pi Bot's servers. The browser store installs and updates it.
- **Images in chat:** images that a reply links from the web aren't loaded automatically. Each one is fetched only when you click it.
- **Default:** allowed.
- **To stop it:** set **Visit websites** to **Ask** or **Never** in Settings › Permissions.

### Commands Bots run

- **Receiver:** package registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`), the sites on your **Allowed websites** list, and servers you set up yourself: SSH hosts in the command environment, and Git remotes when you push or pull from the Changes panel.
- **What is sent:** whatever the command sends. On macOS and Linux commands run in a sandbox: commands that run without asking can reach only the package registries and your list; with **Commands run by bots can access the network** turned on, commands you approve can use the network more widely. Windows has no command sandbox. Verified read-only commands within your permissions can run without asking, and ordinary commands can run in YOLO topics after you consent. The sandbox network list does not limit the commands themselves.
- **Default:** on, within these limits.
- **To limit it:** On macOS and Linux, turn off **Commands run by bots can access the network** to narrow what commands can reach from the sandbox. On Windows, you can withdraw YOLO command consent or restrict **Run commands**. See [Approvals and permissions](../../guide/en/05-approvals-and-permissions.md#command-isolation-sandbox).

## Apps, MCP and skills

### MCP servers and connected apps

- **Receiver:** the service you connect.
  - **MCP by URL:** that address, and its sign-in page if it uses one.
  - **MCP started with `npx` or `uvx`:** the first start downloads the package from `registry.npmjs.org` or from PyPI. The server then runs in the sandbox and can reach only the domains it declares.
  - **Notion:** Notion's hosted MCP server (`mcp.notion.com`); you sign in with Notion in your browser. Read only.
  - **Local calendar, local contacts, Obsidian:** read on this computer, with no network.
- **What is sent:** what each call to that service needs. Writes and outgoing sends are confirmed each time.
- **When / default:** only after you add a connection and give it to a Bot. **Bring over from other AI tools** only reads settings on this computer.
- **To stop it:** remove the connection, or take it away from the Bot.

### Gmail

The Gmail plugin is not in current releases yet; this is how it will connect once it ships, and none of it happens today.

The Gmail plugin has two sign-in methods:

- **Google authorization:** you sign in to Google in your system browser. Google requires a client secret that a desktop app can't keep, so the token exchange goes through Pi Bot's sign-in service `auth.pibot.space`:
  - On connecting, Pi Bot sends `auth.pibot.space` the sign-in parameters: the requested permissions, a one-time PKCE code and the local return address (`127.0.0.1`). Your refresh token comes back encrypted with a key only your computer holds.
  - Each time the plugin uses Gmail, it sends `auth.pibot.space` your refresh token and the client ID to get a short-lived access token. The access token is never saved.
  - Mail itself goes directly between your computer and Google (`gmail.googleapis.com`); `auth.pibot.space` never sees mail content.
- **App password:** Pi Bot talks to `imap.gmail.com` and `smtp.gmail.com` directly, with no Pi Bot server involved.
- **Default:** off until you connect Gmail.
- **To stop it:** disconnect Gmail in the plugin: the token is revoked directly with Google (`oauth2.googleapis.com`) and deleted. Or use the app password method.

### Skills

- **Import from link:** downloads the package from the link you paste: `github.com`, `codeload.github.com` and `api.github.com` for GitHub repositories, or the host of a `.zip` link. Checking a skill for updates from its source contacts the same place.
- **Prepare runtime** (for skills with Python or Node scripts): with your consent, Pi Bot downloads a fixed version of uv from GitHub (`github.com` and GitHub's file hosts), checks its SHA-256, and uses it to download Python (also from GitHub) and the skill's packages from PyPI (`pypi.org`, `files.pythonhosted.org`). Node packages come from `registry.npmjs.org`.
- **What is sent:** ordinary download requests; nothing about you or your files.
- **When / default:** only when you import, check for updates or prepare a runtime.

### External agents

- **Codex and Claude Agent:** when you click **Download and create**, Pi Bot downloads their ACP adapter from `registry.npmjs.org` at fixed versions, checking every file's SHA-256.
- **Running:** once an external agent (Codex, Claude Agent, Cursor, OpenCode) joins as a Bot, it uses its own account and talks to its own vendor, for example `api.openai.com` and `chatgpt.com` for Codex, `api.anthropic.com` and `claude.ai` for Claude, `cursor.com` for Cursor, and `opencode.ai` plus the provider you set in OpenCode. On macOS and Linux Pi Bot limits each agent to its vendor's domains. What it sends follows that vendor's terms.
- **Default:** off until you add one.

## Phone and runners

### Relay

- **Receiver:** the official relay `relay.pibot.space` (on Cloudflare), or your own relay if you set one up (see [Self-hosting the relay](../../guide/en/15-self-hosting-relay.md)).
- **What is sent:** end-to-end encrypted data between your computer, paired phones and runners; the relay can't read it and stores no chats. It sees IP addresses, connection times, frame sizes and which devices are online. The official relay counts accepted connections per day by device kind (computer, phone, runner), with no room ID, device or IP address.
- **When:** while **Allow paired devices to connect** is on (Settings › Devices), and during pairing. A runner connects to the relay it was paired with.
- **Default:** off.
- **To stop it:** turn off **Allow paired devices to connect**, or choose a self-hosted relay under **Advanced**.

### Direct connection (STUN)

- **Receiver:** a STUN service, by default Cloudflare's `stun:stun.cloudflare.com:3478`.
- **What is sent:** a small STUN query from your computer and from the phone or runner, so each learns its public IP address and port and they can try connecting directly. STUN sees only that public address; it never carries chats, files or other data.
- **On your local network:** devices find each other with mDNS (**Local network discovery**) and connect directly; that traffic never leaves your network. A runner started with `--listen` can also be reached at that address.
- **When:** while remote access is on and devices connect.
- **Default:** **Direct connection** is **Allow NAT traversal**; the text you accept before pairing a phone mentions it.
- **To stop it:** set **Direct connection** to **LAN only** (Settings › Devices › Advanced); devices then connect directly only on the same network and use the relay otherwise. You can also enter your own STUN address. **Local network discovery** can be turned off there too.

### Phone notifications

- **Receiver:** Expo's push service (`exp.host`) and Google Firebase Cloud Messaging, which delivers notifications on Android.
- **What is sent:** the phone gets a push token from Expo. When a Bot needs approval or a task finishes or fails, your computer asks the relay to send a push through Expo. It contains only a fixed sentence ("Approval requested", "Task completed", "Task failed") and an encrypted reference that only your phone can read: no chat, approval content or Bot output. To wake the phone app when the computer needs one of the phone's capabilities, a push with no visible text is sent the same way.
- **Default:** only if you allow notifications on the phone.
- **To stop it:** turn off notifications for Pi Bot in the phone's settings, or unpair the phone.

### Phone offline replies

- **Receiver:** the model provider of each Bot you allow, called directly from the phone.
- **What is sent:** the same kind of content as on the computer: the conversation, the Bot's persona and the memories you selected. The keys sync to the phone only after you turn this on. The phone's privacy ledger lists each request (provider, model, number of messages, never the content).
- **When:** only while the computer is offline.
- **Default:** off; turn it on per phone in Settings › Devices › that phone › **When this computer is offline**.
- **To stop it:** turn it off there, revoke the phone or unpair; the keys on the phone are deleted.

## Problem reports

- **Open on GitHub** (your avatar › **Report a problem**) opens a prefilled issue on Pi Bot's GitHub repository in your browser. The address carries only the title and description you wrote, the app version and the operating system. Nothing is sent until you post it on GitHub yourself.
- **Export logs** saves redacted logs to a file on your computer. They contain no chat text, file contents or keys; you decide whether to send them to anyone.

## Other

- **Links you open:** buttons such as the website, **Open download**, browser extension store pages, provider sign-up pages or **Manage usage** for a ChatGPT plan open in your default browser, and only when you click them.
- **Spell-check dictionaries:** on Windows and Linux, the spell checker built into the app's text fields (part of Electron) may download a dictionary for your language from Google's servers. Only the dictionary file is requested. On macOS the system spell checker is used.
- **Sandbox doctor:** running the app with `--sandbox-doctor` (see [Approvals and permissions](../../guide/en/05-approvals-and-permissions.md#sandbox-doctor)) sends test requests to `example.com` and `example.org`, with no chat, file content or keys.

## Using Pi Bot fully offline

Choose a local model, set **Visit websites** to **Never** and turn off **Commands run by bots can access the network**; conversations and files then stay on this computer. Desktop update checks and anything you start yourself (role library, skill imports, plugins) still connect as described above. See [Privacy and security](../../guide/en/13-privacy-and-security.md#fully-offline-use).
