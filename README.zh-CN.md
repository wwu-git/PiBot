# Pi Bot

**开源、本地优先的桌面 AI 智能体团队。** 一群有名字的 AI Bot 在你自己的电脑上干活：私聊或拉群，它们会做计划、跑命令、改文件、上网、操作电脑，
有风险的步骤都等你批准。支持 macOS、Windows、Linux，另有安卓 App。agent 内核是 [pi](https://github.com/earendil-works/pi)。

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="https://github.com/w01fb0ss/PiBot/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/w01fb0ss/PiBot?include_prereleases"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android-lightgrey">
  <a href="https://pibot.space"><img alt="Website" src="https://img.shields.io/badge/website-pibot.space-8b5cf6"></a>
  <a href="https://pibot.space/cn/guides/"><img alt="文档" src="https://img.shields.io/badge/docs-pibot.space%2Fcn%2Fguides-0ea5e9"></a>
</p>

<p align="center">
  <a href="docs/assets/pibot-intro-60s.mp4"><img src="docs/assets/pibot-intro-15s.gif" width="800" alt="15 秒看 Pi Bot（点开看 60 秒有声完整版）"></a>
</p>

<p align="center">▶ <a href="docs/assets/pibot-intro-60s.mp4">看 60 秒视频</a> · <a href="https://pibot.space">下载</a> · <a href="docs/guide/README.md">使用指南</a> · <a href="https://pibot.space/cn/guides/">在线文档</a></p>

[English](README.md) · [中文](README.zh-CN.md) · [日本語](README.ja.md)

Pi Bot 是一个桌面应用：一群有名字的 Bot 在你自己的电脑上干活。你可以和某个 Bot 私聊，也可以把几个 Bot
拉进群聊；给它们一个工作文件夹，它们会做计划、跑命令、改文件、互相交接，有风险的步骤都等你批准。
「大脑」也运行在你的电脑上：聊天、文件、记忆和密钥都留在本机，只有你选的模型服务商会看到你发出的提示。

官网与下载：<https://pibot.space> · 使用指南：[docs/guide](docs/guide/README.md) · 在线文档：<https://pibot.space/cn/guides/>

## 能做什么

- **Bot 与角色**：给 Bot 起名字、选角色（开发、研究、写作、翻译……），各自的模型、技能、权限和记忆。
- **私聊和群聊**：群里有统筹 Bot 做计划、把步骤交给成员、汇总结果；计划经你确认后才执行。
- **工作文件夹与改动**：Bot 在你选的文件夹里工作，每处改动都列出来、可以审查；macOS 上还能从自动检查点恢复。
- **审批与权限**：每次工具调用都经过同一个策略引擎；命令在沙箱里运行
  （[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)），审批、命令和对外发送都写进审计日志。
- **例行任务与待办**：定时、文件夹触发、连接事件触发的任务。
- **连接**：应用、MCP 服务、技能和知识库。
- **模型**：Ollama 本地模型、OpenRouter、自带 API Key，以及支持的订阅登录。
- **更多设备（可选）**：Android 手机 App、装在其他电脑或服务器上的执行端、可以自建的中继，以及通过 ACP 在编辑器里使用。

Pi Bot 支持 macOS 13 Ventura 及以上、Windows 10 / 11 和 64 位 Linux。没有遥测，Pi Bot 自己的服务器收不到你的聊天和文件。除了你选的模型服务商，只在检查更新、Bot 访问网站和搜索、以及你打开的功能（手机、执行端、连接）时联网，打开前会说明。
每一项对外连接见 [docs/privacy](docs/privacy/zh/outbound-connections.md)。

## 安装

从 <https://pibot.space> 下载桌面版，然后看[安装与第一次使用](docs/guide/zh/01-getting-started.md)。

## 从源码构建

需要 [`.nvmrc`](.nvmrc) 里的 Node 版本和 pnpm 12。

```sh
git clone https://github.com/w01fb0ss/PiBot.git
cd PiBot
nvm use
pnpm install
pnpm dev        # 开发模式启动桌面应用
```

设置 `PIBOT_DATA_DIR` 可以让开发数据和已安装的 Pi Bot 分开。其他命令：

| 命令 | 用途 |
|---|---|
| `pnpm check` | 冻结安装、类型检查、lint、策略矩阵和测试 |
| `pnpm check:changed [base]` | 同样的检查，只查改动的部分 |
| `pnpm verify` | `check`、构建、界面启动检查和端到端验收 |
| `pnpm build` | electron-vite 构建（不打安装包） |

## 仓库结构

| 路径 | 内容 |
|---|---|
| `apps/desktop` | Electron 应用（主进程、界面、打包） |
| `apps/mobile` | Android App（React Native + Expo） |
| `apps/relay` | 手机和执行端连接用的中继（Cloudflare Worker） |
| `apps/runner`、`apps/cli` | 无界面执行端和命令行入口 |
| `apps/plugins` | 内置插件（MCP 和 / 或技能） |
| `packages/teams/builtin` | 随应用打包、离线可用的角色和群；完整角色库在 [pibot-roles](https://github.com/w01fb0ss/pibot-roles) |
| `packages/*` | 大脑和各项能力，分五层，见 [AGENTS.md](AGENTS.md) |
| `docs/guide`、`docs/privacy` | 使用指南和对外连接说明 |
| `tests`、`tools` | 端到端验收、假模型和开发工具 |

agent 内核是 [pi](https://github.com/earendil-works/pi)，作为锁定版本的 npm 依赖，只在 `packages/agent`
里使用。大脑不依赖 Electron，同一份代码也能无界面运行。

## 参与贡献

欢迎提 Issue 和 PR。请先读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md) 里的规则；
安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要发公开 Issue。

## Star 趋势

<a href="https://www.star-history.com/#w01fb0ss/PiBot&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date" />
  </picture>
</a>

## 许可

[Apache License 2.0](LICENSE)。署名见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
