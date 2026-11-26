# Pi Bot Plugin SDK / 插件 SDK

源码唯一位置是 `sdk/plugin-sdk`。它与 `packages/sdk`（Pi Bot 客户端 SDK）不同。
The plugin SDK lives here; `packages/sdk` is the separate Pi Bot client SDK.

需要 Node.js 22+。在仓库中构建和打包 / Build and pack in this repository:

```sh
pnpm --filter @pibot/plugin-sdk build
pnpm --filter @pibot/plugin-sdk run pack
```

产物 / Outputs: `dist/index.js` (ESM), `dist/index.d.ts`, `dist/pibot-plugin-sdk-0.0.0.tgz`.
发布包不含源码工作区依赖；第三方运行依赖会由 npm 安装。
The tarball bundles Pi Bot protocol definitions; npm installs the pinned third-party runtime dependencies.

在自己的项目安装 / Install in your own project:

```sh
npm init -y
npm install /absolute/path/to/pibot-plugin-sdk-0.0.0.tgz
npm install --save-dev typescript esbuild @types/node
```

## 最小服务 / Minimal server

保存为 `server.ts`。只读工具标记 `readOnlyHint: true`；写工具必须为 false。
Save this as `server.ts`. Pi Bot routes write calls through its confirmation/draft flow; annotations do not grant authorization.

```ts
import { serveStdio } from "@pibot/plugin-sdk";

await serveStdio({
  id: "hello",
  open: async () => ({
    listTools: async () => ({ tools: [
      { name: "hello", description: "问好 / Say hello", readOnlyHint: true,
        inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "write_note", description: "确认后写入便签 / Write a note after confirmation",
        readOnlyHint: false, inputSchema: { type: "object", properties: {
          text: { type: "string", minLength: 1, maxLength: 1000 }
        }, required: ["text"], additionalProperties: false } }
    ] }),
    onToolsChanged: () => () => undefined,
    callTool: async ({ tool, args, signal }) => {
      signal.throwIfAborted();
      if (tool === "hello") return { text: "Hello / 你好" };
      if (tool === "write_note") return { demo: true, text: args.text };
      throw new Error("unknown_tool");
    },
    close: async () => {},
  }),
});
```

这是演示，write_note 不实际写文件。真实实现须处理取消、超时、清理；stdout 仅用于 MCP，不记录密码或邮件等内容。
The example does not persist notes. Real adapters must handle cancellation, deadlines and cleanup; reserve stdout for MCP and never log secrets or content.

## 插件自己的密钥 / Plugin-owned secrets

在 `open` 回调中使用 `secrets.get(name)`、`secrets.set(name, value)`、`secrets.delete(name)` 保存 OAuth 刷新令牌等插件运行时凭据。宿主把请求绑定到当前安装 id；每个值最多 8 KiB、最多 32 项、总量最多 32 KiB。值不会进入 MCP 工具结果、日志、文件或模型，也不能访问其他插件的密钥。卸载插件时宿主会删除该安装的密钥空间。

Use `secrets.get(name)`, `secrets.set(name, value)`, and `secrets.delete(name)` in `open` for runtime credentials such as OAuth refresh tokens. The host binds requests to the current installation, limits each value to 8 KiB / 32 entries / 32 KiB total, and never puts values in tool results, logs, files, or model messages. Uninstall removes the installation scope.

## 插件包 / Plugin folder

```text
hello-plugin/
  .claude-plugin/plugin.json
  .mcp.json
  server.mjs
  skills/hello/SKILL.md
```

`.claude-plugin/plugin.json`:

```json
{
  "name": "hello",
  "version": "0.0.1",
  "description": "Example / 示例",
  "pibotApp": true,
  "userConfig": {
    "LOGIN_MODE": {
      "type": "string",
      "title": "登录方式 / Login method",
      "description": "补充配置说明 / Setup guidance",
      "options": [
        { "value": "token", "label": "令牌 / Token" },
        { "value": "oauth", "label": "OAuth / OAuth" }
      ],
      "default": "token"
    },
    "API_KEY": {
      "type": "string",
      "title": "密钥 / API key",
      "sensitive": true,
      "visibleWhen": { "key": "LOGIN_MODE", "equals": "token" }
    }
  }
}
```

小匠制作的连接必须声明 `"pibotApp": true`。它会作为 Pi Bot 应用卡片出现在「应用」里；不要把它当作技能包或普通 MCP 导入。
Plugins made by Forge must declare `"pibotApp": true`. Pi Bot shows them as application cards in Applications; do not deliver them as skill-only packages or ordinary MCP imports.

`userConfig` 支持 `options`（双语选择项）和 `visibleWhen`（按另一个字段的值显示）。互斥登录方式应使用条件显示，并让当前分支的凭据字段设为 `required`；所有字段都应提供用户可读的双语标题和补充说明。敏感字段只是由插件声明所需的凭据类型；`plugin_install` 只接受非敏感配置，实际密钥必须让用户到「连接 → 访问令牌」配置，不把内部环境变量名直接展示给用户。
`userConfig` supports `options` (bilingual choices) and `visibleWhen` (show a field when another field has a value). For mutually exclusive login methods, use conditional visibility and make the active branch's credential fields `required`; every field should have a human-readable bilingual title and setup guidance. Sensitive fields declare what the plugin needs; `plugin_install` accepts only nonsensitive settings, while the user configures the actual credential under Connections → Access tokens. Do not expose internal environment names as user copy.

`title`、`description` 和选项的 `label` 可以写成「中文 / English」，也可以写成 `{ "zh": "个人访问令牌", "en": "Personal access token" }`；Pi Bot 按界面语言只显示一种。工具可以在 MCP 的 `title`（或 `annotations.title`）里给出给人看的名字，同样支持「中文 / English」；没有时 Pi Bot 把工具名转成词组显示。
`title`, `description` and option `label`s may be "中文 / English" or `{ "zh": "…", "en": "…" }`; Pi Bot shows the one matching the UI language. Give tools a human name in MCP `title` (or `annotations.title`), also "中文 / English" if you like; without one Pi Bot turns the tool name into words.

`.mcp.json`:

```json
{"mcpServers":{"hello":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.mjs"],"env":{"HELLO_API_KEY":"${user_config.API_KEY}"},"networkDomains":[]}}}
```

敏感 userConfig 走 Pi Bot 凭据库，不把真实密钥填进包；运行时 OAuth 刷新令牌使用安装级 `secrets`。
Sensitive settings use Pi Bot's credential store; never ship real credentials. Runtime OAuth refresh tokens use installation-scoped `secrets`.

小匠构造插件需要 API key 或其他 secret 时，应提示用户到「连接 → 访问令牌」配置，使用 Pi Bot 现有的访问令牌 / secret 通道。不得让用户在聊天、`plugin_install` 配置、源码、`.env`、命令参数、日志或插件包中提交或保存密钥；插件只能声明敏感配置字段，由宿主在运行时安全注入。
When Forge builds a plugin that needs an API key or another secret, direct the user to Connections → Access tokens and use Pi Bot's existing token / secret channel. Never ask the user to submit or store a credential in chat, `plugin_install` config, source, `.env`, command arguments, logs, or the plugin package; the plugin may only declare sensitive fields for the host to inject at runtime.

`skills/hello/SKILL.md` 使用 YAML front matter 的 `name`、`description`，正文描述工具用途；技能说明不授予权限。
Use SKILL.md front matter (`name`, `description`) and guidance in the body; a skill never grants permissions.

打成可分享的单文件服务（纯 JS 依赖时）/ Bundle a single-file service (for pure JS dependencies):

```sh
npx esbuild server.ts --bundle --platform=node --format=esm --target=node22 --outfile=hello-plugin/server.mjs
```

若依赖使用动态 require，需要提供 createRequire banner 或采用相应构建配置；参照 Gmail 构建脚本。
Dependencies using dynamic require need a createRequire banner or compatible build configuration; see the Gmail build script.

在 Pi Bot「连接 → 添加 → 从文件夹导入插件包」选择 `hello-plugin`，检查预览、配置敏感字段、确认网络域名和 Bot 访问范围。只读/写工具仍受 Pi Bot 策略、逐次确认和审计约束；不关闭沙箱。`command: node` 使用 Pi Bot 安装包自带的 helper Node。
In Pi Bot choose Connections → Add → Import plugin folder, select the folder, then review settings, network domains and Bot access. Keep the sandbox on; writes still require Pi Bot's draft/confirmation flow. `command: node` uses Pi Bot's bundled helper Node.

完整示例 / Complete example: [Gmail](../../apps/plugins/gmail/plugin/README.md), [build script](../../apps/plugins/gmail/scripts/build.mjs).
