# pi SDK 摸底

> 当前版本（2026-11-23）：pi-ai / pi-coding-agent 及传递的 pi-agent-core 精确锁定 **1.6.0**，`probe` 核对该版本。下方 1.1.0 的早期记录供溯源。

2026-10-09，Node **26.11.1**、pnpm **10.28.2**。安装时 npm `latest` 为
[`@earendil-works/pi-coding-agent@1.1.0`](https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest)，
在本包的 dependencies 精确锁定 **1.1.0**，根包没有添加 pi 依赖。
`pnpm-lock.yaml` 同时锁住传递依赖；本次解析的 pi-ai、pi-agent-core、pi-telemetry、pi-mcp、pi-codemode、pi-tui 和 chord 都是 **1.1.0**。

下面保留对锁定版本声明和行为的核实结论。正式封装与接入说明见文末。

```sh
pnpm --filter @pibot/agent probe
```

probe 用 Node 的 TypeScript 类型擦除执行，无额外执行器依赖。脚本单独纳入本包
`typecheck`；TypeScript 7 的命令行文件检查需要 `--ignoreConfig`。未改根 package.json 或本包 tsconfig。

## 实际接口与旧规格的差异

签名来源为已安装包的 `dist/index.d.ts`、`dist/core/*.d.ts`；行为核对相应 `.js`。
公共入口是 `@earendil-works/pi-coding-agent`。下面省略与首版无关的选项。

| 旧规格 / 计划 | 1.1.0 的实际接口 | 处理方式与验证 |
|---|---|---|
| `AuthStorage.inMemory()` | 内部类仍有 `static inMemory(data?: Record<string, Credential>): AuthStorage`，**公共入口不再导出 AuthStorage** | probe 通过已安装文件 URL 调查；生产封装不要依赖内部路径，使用下面的公开 `credentials` 注入接口 |
| `AuthStorage.set` / `getAuthStatus` / `getApiKey` | 三者均不存在；改为 `read(providerId, options?): Promise<Credential \| undefined>`、`modify(providerId, async current => next, options?): Promise<Credential \| undefined>`、`delete(providerId, options?): Promise<void>`、`list(options?): Promise<readonly CredentialInfo[]>` | 状态由 `ModelRuntime.getProviderAuthStatus()` 查询；Key 由 `getAuth(...).auth.apiKey` 解析 |
| `ModelRegistry.inMemory(authStorage)` | 不存在。公开构造器为 `new ModelRegistry(runtime: ModelRuntime)` | `await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false })`，然后按需套兼容 facade |
| `getAll` / `getAvailable` / `find` | `getAll(): Model<Api>[]`、`getAvailable(): Model<Api>[]`、`find(provider, modelId): Model<Api> \| undefined` | 兼容 facade 仍提供同步快照；变更后先 await `runtime.refresh({ allowNetwork: false })` 或 `runtime.getAvailable()` |
| `registerProvider` | `registerProvider(provider: Provider): void` 或 `registerProvider(id: string, config: ProviderConfigInput): void` | `ModelRuntime` 也有配置式 `registerProvider(id, config)`；自定义模型和可用性已验证 |
| `SettingsManager.inMemory` | `static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager` | `enableInstallTelemetry: false`；probe 还设 `cacheWarming: "off"`、`compaction: { enabled: false }` |
| `SessionManager.create` / `open` | `create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager`；`open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager` | 显式目录仍有效；create 不立即写 JSONL，probe 用本地 header fixture 验证 open、目录和 cwd |
| 内存会话 | `inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[]): SessionManager` | probe 建会话时用它；P7 的磁盘 API 另行检查 |
| `DefaultResourceLoader` | `new DefaultResourceLoader({ cwd, agentDir, settingsManager?, noExtensions?, noSkills?, noPromptTemplates?, noThemes?, noContextFiles?, systemPrompt?, ... })` | 五个 `no*` 均存在；reload 后资源为空、systemPrompt 正确，**但仍有发现扫描**，见 P8 |
| `createAgentSession` | `createAgentSession(options?: CreateAgentSessionOptions): Promise<{ session: AgentSession; extensionsResult; modelFallbackMessage? }>` | 传入 `cwd, agentDir, modelRuntime, settingsManager, sessionManager, resourceLoader, noTools: "all"`；旧 `authStorage` / `modelRegistry` 参数已改为 `modelRuntime` |
| 订阅、提示、停止 | `subscribe(listener: (event: AgentSessionEvent) => void): () => void`；`prompt(text: string, options?: PromptOptions): Promise<void>`；`abort(): Promise<void>`；`dispose(): void` | subscribe / unsubscribe、无凭据 prompt 的请求前拒绝、空闲 abort / dispose 已运行 |

`ModelRuntime.create(options?: CreateModelRuntimeOptions): Promise<ModelRuntime>` 的隔离相关选项：

- `credentials?: CredentialStore`：省略会默认创建文件 AuthStorage，必须传。
- `modelsPath?: string | null`：**必须传 null**；省略会读默认 `models.json`。null 同时让默认 modelsStore 留在内存。
- `modelsStore?: ModelsStore`、`modelsStorePath?: string`：未显式提供 store 时按 modelsPath 选择内存或文件。
- `allowModelNetwork?: boolean`：默认 false；probe 显式 false。`PI_OFFLINE` 存在时也禁止模型目录网络刷新。
- `refreshOnCreate?: boolean`：默认刷新本地模型与认证可用性；false 会跳过初始刷新，不能把空快照当作认证结论。
- `getModels(providerId?): readonly Model<Api>[]`、`getModel(providerId, modelId): Model<Api> | undefined`、`getProviders(): readonly Provider[]`。
- `getAvailable(providerId?, options?): Promise<readonly Model<Api>[]>`、`getAvailableSnapshot(): readonly Model<Api>[]`。
- `getProviderAuthStatus(providerId): { configured: boolean; source?; label? }`。
- `getAuth(providerId | model, overrides?): Promise<AuthResult | undefined>`，override 支持 `apiKey`、`env`、取消信号等。
- `setRuntimeApiKey(providerId, apiKey, options?): Promise<void>`、`removeRuntimeApiKey(providerId, options?): Promise<void>`：仅运行时覆盖，并同步本地认证快照。

文字增量事件是 **`message_update` → `assistantMessageEvent.type === "text_delta"` → `.delta`**。
probe 的 `textDelta()` 通过实际 `AgentSessionEvent` 类型检查。`prompt()` 本身返回 void；结束原因和 usage 应从事件或最终 assistant message 取得。
本轮没有真实流式请求，也没有验证运行中 abort；这些留给正式封装的假模型测试。
未配模型时 session 底层可能持有 `provider/id: "unknown"` 占位模型，prompt 报 `No API key found for the selected model`。
正式封装应依据可用模型状态映射 `no_model`，不能仅检查 `session.model === undefined`。

## P1–P10 的实现路径

| 要求 | 1.1.0 的做法及证据 |
|---|---|
| P1：只用 SDK | 动态导入 npm 公共入口，调用 createAgentSession；不启动 pi CLI。probe 拦截全部 Node 子进程入口，调用尝试为 0 |
| P2：不碰用户 `.pi` | 显式 cwd / agentDir，内存 credentials、`modelsPath: null`、内存 settings、显式 sessionManager、静态 ResourceLoader；在导入前覆盖 HOME / USERPROFILE。`PI_CODING_AGENT_DIR` 也显式指向独立 agentDir，防止内部辅助路径回退。不要继承用户的 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` |
| P3：凭据归 Pi Bot | 公开 `CreateModelRuntimeOptions.credentials` 是 CredentialStore（read/list/modify/delete）。封装可使用 Pi Bot 自己的字面值内存实现；probe 已验证，不读文件、不做配置表达式解析。也可使用 pi-ai 公共 `InMemoryCredentialStore`，届时应在 agent 包显式增加精确依赖，不能依赖 pnpm 隐式提升 |
| P4：模型归 Pi Bot | ModelRuntime 内存配置 + 可选 ModelRegistry facade。注册 config **不带 apiKey**，由 `setRuntimeApiKey` 注入已校验字面 Key；这是旧 `authStorage.set` 的等效替代。probe 验证自定义模型可列出、只返回配置的厂商；取消 Key 后不可用 |
| P5：拒绝 `!` | 输入和存储仍须拒绝首字符 `!`。内部 AuthStorage.read、注册厂商 apiKey、厂商/模型 headers 均可能进入配置解析器，不能绕过校验。`!` 的执行路径只读源码确认，probe 没有执行任何命令。请求头还要将字面 `$` 编码成 `$$` 再交给 pi，避免模板替换；probe 验证了这个往返 |
| P6：设置不落盘、关遥测 | SettingsManager.inMemory + `enableInstallTelemetry: false`，再设 `PI_TELEMETRY=0`、`PI_OFFLINE=1`。安装遥测状态函数返回 false，agentDir 保持空目录。无需要自动上报的功能；不注入外部 telemetryContext |
| P7：会话目录 | create(botHome, sessionDir)、open(file, 同一 sessionDir)；不要使用默认目录。probe 的 JSONL header、创建和重开路径都只在独立 bots/probe/sessions；聊天检查采用 inMemory，不写会话 |
| P8：不发现外部资源 | **需要等效替代**：DefaultResourceLoader.reload 先调用 DefaultPackageManager.resolve，再按 no* 过滤；resolve 会扫描 user/ancestor `.agents/skills` 等，所以 flags 仅保证不加载。封装使用公开 ResourceLoader 接口的静态实现：所有资源列表为空、自己的 systemPrompt、无扫描的 reload/extendResources。probe 实际用这个 loader 建会话；不传 extensionFactories / 额外资源 / 内置 MCP 扩展 |
| P9：干净环境 | 导入前清理厂商认证环境，设 `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`。probe 完全隔离继承环境，并以新包发现的变量集合 + 审核补充项复现假环境变量隔离。**inMemory 不会自动禁止环境认证**，详情见下节 |
| P10：首版全部工具关闭 | createAgentSession 的 `noTools: "all"` 仍有效，不传 tools / customTools；不加载扩展。probe 断言 active tool 名单与 `session.agent.state.tools` 均为空；不要通过后续 setActiveTools 或工具修饰选项重新开启 |

这些调整使用新包的等效接口作为退路，没有放宽隔离要求。正式封装再把它们做成封装代码与 Vitest 回归测试。

## 凭据优先级、配置值解析、网络开关

**AuthStorage.inMemory 只保证存储在内存。** 本身不自动从 OPENAI_API_KEY 选择凭据，但
`read()` 会将已存 Key 交给 `resolveConfigValue`：`$OPENAI_API_KEY` 能读到环境里的假 Key。
它没有旧 `getApiKey`；真正的认证在 ModelRuntime / pi-ai 的 resolveProviderAuth 中完成。
对普通 API Key 厂商，实际优先级为：

1. 请求 `getAuth(..., { apiKey })` 覆盖。
2. `setRuntimeApiKey` 的字面内存覆盖。
3. 注入 CredentialStore 的已存凭据；OAuth 凭据走对应 handler / 必要时刷新。
4. 注册 config / models.json 的配置 Key（Pi Bot 不使用这个存 Key）。
5. 厂商的环境变量或云认证来源；普通 Key 厂商采用第一个非空环境值。

probe 验证 OpenAI 的 request → runtime → stored → environment。源码另行确认：存储凭据类型不匹配或 OAuth 刷新失败时不会悄悄回退环境。
云厂商还可能按字段读取环境和本机 AWS / ADC 文件，首版不启用它们；列目录也应清理附录清单，不可只传 `{ env: {} }`。
空 env 的多个兼容解析器仍会回退 process.env。

`registerProvider` 的 apiKey **会解析**；一般延迟到认证解析时执行，不能因为注册成功或只列模型未执行就认定安全：

- `!command`：执行 shell；**本轮只核对源码，不触发这个分支**。
- `$NAME` / `${NAME}`：环境变量插值，`$$` 是字面 `$`、`$!` 是字面 `!`。
- 裸 `OPENAI_API_KEY`：新版是普通字面字符串，已不同于旧版“裸变量名”约定。
- headers 同样解析；模型级 headers 在 `getAuth(model)` / 发请求时合并。
- runtime Key、字面 CredentialStore 可保留 `$` 原样；仍须拒绝 `!`，避免后来误交给配置解析器。

安装遥测对应 InteractiveMode 的首次安装/升级版本 ping；settings 默认 true。
`PI_TELEMETRY` 设置后优先于 settings（`0` 关闭，`1` / `true` / `yes` 开启），所以必须显式覆盖继承值。
`PI_OFFLINE` 同时阻止该 ping、目录刷新、管理下载等；**不阻止用户主动调用模型 API**，不能用它当网络沙箱。
`PI_SKIP_VERSION_CHECK=1` 关闭 `checkForNewPiVersion`；`PI_OFFLINE=1` 也让底层 `getLatestPiRelease` 返回 undefined。
两条版本检查路径都在 probe 中运行，网络尝试为 0。

## 厂商、环境变量与 OAuth 目录

厂商优先取 `runtime.getProviders()`，包含运行时注册项；静态厂商可从
`@earendil-works/pi-ai/providers/all` 的 `builtinProviders()` / `getBuiltinProviders()` 取得。
锁定版本的离线 runtime 为 **42 个厂商、1,563 个聊天模型**；别沿用架构文档里旧版 31 / 885 的静态数字。
`azure-openai-responses` 的厂商 id 已为 **`azure`**（API id 仍是 azure-openai-responses）。

没有公开导出完整的“厂商 → 环境变量”映射对象；内部 `getApiKeyEnvVars()` 未导出。
公共兼容入口 **`@earendil-works/pi-ai/compat`** 导出
`findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined` 和 `getEnvApiKey(...)`。
findEnvKeys 只返回“有值的 API Key 变量名”，不包含全部云凭据；probe 用**假的全有值 Proxy**查询它，
并调用厂商 `auth.apiKey.resolve` 的无值 AuthContext，记录变量名、不访问真实文件。
它输出 `providerEnv` 和补齐短路分支、请求配置后的 `envNames`，用于更新环境变量附录。
probe 对 pi-ai 的传递依赖路径读取仅为这次调查；生产代码需要显式声明依赖后使用公共入口。

| 厂商 id | API Key 变量（同一行共用；不是环境优先级排序） |
|---|---|
| anthropic | ANTHROPIC_AUTH_TOKEN、ANTHROPIC_OAUTH_TOKEN、ANTHROPIC_API_KEY |
| openai | OPENAI_API_KEY |
| azure | AZURE_OPENAI_API_KEY |
| google | GEMINI_API_KEY |
| google-vertex | GOOGLE_CLOUD_API_KEY |
| ant-ling | ANT_LING_API_KEY |
| baseten | BASETEN_API_KEY |
| cerebras | CEREBRAS_API_KEY |
| cloudflare-workers-ai / cloudflare-ai-gateway | CLOUDFLARE_API_KEY |
| deepseek | DEEPSEEK_API_KEY |
| fireworks | FIREWORKS_API_KEY |
| github-copilot | COPILOT_GITHUB_TOKEN |
| groq | GROQ_API_KEY |
| huggingface | HF_TOKEN |
| kimi-coding | KIMI_API_KEY |
| meta | META_API_KEY |
| minimax / minimax-cn | MINIMAX_API_KEY / MINIMAX_CN_API_KEY（分别） |
| mistral | MISTRAL_API_KEY |
| moonshotai / moonshotai-cn | MOONSHOT_API_KEY |
| nvidia | NVIDIA_API_KEY |
| opencode / opencode-go | OPENCODE_API_KEY |
| openrouter | OPENROUTER_API_KEY |
| qwen-token-plan / qwen-token-plan-individual | QWEN_TOKEN_PLAN_API_KEY |
| qwen-token-plan-cn | QWEN_TOKEN_PLAN_CN_API_KEY |
| radius | RADIUS_API_KEY |
| together | TOGETHER_API_KEY |
| typesafe | TYPESAFE_API_KEY |
| vercel-ai-gateway | AI_GATEWAY_API_KEY |
| xai | XAI_API_KEY |
| xiaomi | XIAOMI_API_KEY |
| xiaomi-token-plan-cn / -ams / -sgp | XIAOMI_TOKEN_PLAN_CN_API_KEY / XIAOMI_TOKEN_PLAN_AMS_API_KEY / XIAOMI_TOKEN_PLAN_SGP_API_KEY（分别） |
| zai / zai-coding-cn | ZAI_API_KEY / ZAI_CODING_CN_API_KEY（分别） |
| amazon-bedrock | AWS_BEARER_TOKEN_BEDROCK 或下面的 AWS 凭据来源 |
| openai-codex | 无 API Key 环境入口，OAuth |

还须清理这些云认证 / 配置项；下列是源码审核的补充清单，不声称 findEnvKeys 会导出它们：

- Anthropic federation：`ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID`、`ANTHROPIC_SERVICE_ACCOUNT_ID`、`ANTHROPIC_IDENTITY_TOKEN_FILE`、`ANTHROPIC_WORKSPACE_ID`。
- AWS：`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN`、`AWS_PROFILE`、`AWS_DEFAULT_PROFILE`、`AWS_SHARED_CREDENTIALS_FILE`、`AWS_CONFIG_FILE`、`AWS_WEB_IDENTITY_TOKEN_FILE`、`AWS_ROLE_ARN`、`AWS_ROLE_SESSION_NAME`、`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`、`AWS_CONTAINER_CREDENTIALS_FULL_URI`、`AWS_CONTAINER_AUTHORIZATION_TOKEN`、`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`。
- Vertex：`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_PROJECT`、`GCLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`；解析器还会检查默认 ADC 文件，单纯删路径变量不能阻止这个检查。
- Cloudflare：`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_GATEWAY_ID`。
- Azure 请求配置：`AZURE_OPENAI_BASE_URL`、`AZURE_OPENAI_RESOURCE_NAME`、`AZURE_OPENAI_API_VERSION`、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。
- 保留旧附录的防御性清理：`GH_TOKEN`、`GITHUB_TOKEN`；新 Copilot API Key provider 只声明 COPILOT_GITHUB_TOKEN。

**OAuth 没有旧 `getOAuthProviders()` 列表导出**；`pi-ai/oauth` 在这个版本是空运行时入口。
用 `runtime.getProviders().filter(p => p.auth.oauth)`（或 builtinProviders 同样过滤），读取
`auth.oauth.name` / `isSubscription` / `loginLabel`，无须调用 login。实际列表：

| id | OAuth 名称 | isSubscription |
|---|---|---|
| anthropic | Anthropic (Claude Pro/Max) | true |
| github-copilot | GitHub Copilot | true |
| kimi-coding | Kimi Code (subscription) | true |
| meta | Meta (Muse subscription) | true |
| openai | OpenAI (ChatGPT subscription) | true |
| openai-codex | OpenAI (ChatGPT Plus/Pro) | true |
| openrouter | OpenRouter OAuth | false |
| radius | Radius | false |
| xai | xAI (Grok/X subscription) | true |

同一厂商可能同时有 apiKey 和 oauth（如 openai、anthropic、xai）；首版保留其 API Key 路径，OAuth 入口按规格标即将支持。
认证方式不是互斥的单一标签；别因为有 oauth 就把其 API Key 从首版目录中移除。

## 本轮验证结果与限制

probe 分两阶段，**导入 pi 前**将 HOME、USERPROFILE 和应用配置路径指向临时目录；finally 恢复环境与拦截函数、删除自己创建的临时根目录。

1. 全新 HOME：列模型、认证优先级 / 自定义厂商检查、全部 no* 检查、静态 loader 建内存会话后，**HOME 下没有生成 `.pi`**，独立 agentDir 为空。
2. 预置 HOME/.pi/agent/auth.json 假 Key，并设置 OPENAI_API_KEY=fake-env，再按发现清单清理环境：OpenAI 未配置 / 不在 available 列表。建会话和显式 create/open 检查结束后，`.pi` 只有原来的 auth.json，内容及 mtime 不变；readFileSync / promises.readFile 拦截的外部凭据读取尝试为 **0**。

整个 probe 的 fetch、HTTP(S)、Socket 与子进程入口有拒绝拦截，最终网络 / 子进程调用尝试均为 **0**。
`!` 执行行为仅源码确认；文字增量只验证类型和事件路径；没有真实 Key、模型网络请求、OAuth 登录或运行中停止测试。
实际运行平台为 macOS；代码使用 Node API 与 path.join，无 shell 环境赋值，Windows / Linux 本轮没有实机验证。

合并前运行 `pnpm typecheck && pnpm lint && pnpm test`。

## 正式封装

公共入口 `@pibot/agent` 导出 `createAgentRuntime`、`listProviderCatalog`、
`sanitizeBrainEnv`、`BRAIN_AUTH_ENV_NAMES`、`mapAgentError`、`AgentError` 和接口类型。
不依赖 store 或 Electron，不暴露 pi 会话、工具或运行时修改入口。

```ts
const runtime = createAgentRuntime({ dataDir, hasApiKey, getApiKey, customProviders });
const models = await runtime.listModels({ availableOnly: true });
const session = await runtime.openSession({
  botId, homeDir, sessionDir, sessionFile,
  model: { provider, id }, thinkingLevel: "off", systemPrompt,
});
try {
  const result = await session.prompt("Hello", ({ text }) => receiveDelta(text));
} finally {
  session.dispose();
}
```

- `createAgentRuntime` 仍同步；`listModels` 改为 **`Promise<ModelInfo[]>`**。
  保留异步签名用于构建 SDK runtime；可用性通过 `hasApiKey` 和 auth.check 只读数据库元数据。
  `getApiKey` 只在测试连接、打开聊天会话和每次 prompt 前读取当前厂商，不在模型列表中调用。
  每次列模型、建会话、测试厂商都会新建隔离运行时；已有会话每次 prompt 也刷新所选厂商 Key。
- brain 应在其他初始化之前调用 **`sanitizeBrainEnv(process.env, dataDir)`**。
  第二个参数可省略，但此时必须已有 `PIBOT_DATA_DIR`；不从 store 计算目录，不回退用户的 pi 路径。
  agent 自身也在动态导入 coding-agent 前清理环境。这个包必须只在 brain 进程使用，
  不能在要保留原始环境用于导入检测的 main 进程创建 runtime。
- `CustomProviderConfig` 无 `apiKey`，id 必填；通过注入函数取配置和 Key。
  config 用 protocol schema 校验，拒绝未知字段、重复 id 和覆盖内置厂商。
  `fetchCustomModels` 接受 protocol 的 `{ baseUrl, api, apiKey?, headers? }`，不用提供 name。
  OpenAI/Anthropic 读 `/models` 的 `data[].id`；Google 读 `models[].name` 并去掉 `models/`。
  模型发现拒绝 HTTP 重定向，10 秒超时；测试厂商只有用户调用时才发请求。
- 内存 `ModelRuntime` 使用 `refreshOnCreate: false`，在认证解析之前先通过公开
  `registerNativeProvider` 替换内置 ambient auth（先替换 Vertex，避免注册触发的后台刷新探测 ADC）。
  首版只启用目录中的 API Key 厂商；订阅与云厂商不读取注入 Key，也不探测本机凭据。
  再显式 `refresh({ allowNetwork: false })`，避免将未经刷新的空快照当作结论。
- 自定义厂商先 `registerProvider`，配置 Key 始终缺省，请求头 `$` 编码成 `$$`。
  再用公开 native registration 保留该 provider 的模型/流函数，替换为字面值认证，
  native auth 直接接收已校验的原始 header，不经过表达式解析。
  因 1.1.0 的 HTTP 客户端要求非空 Key，无 Key 的本机服务使用内存占位值
  `pibot-keyless`；OpenAI/Anthropic 的认证头用 null 抑制，用户显式请求头优先。
  真实 OpenAI 兼容客户端的假 SSE 测试确认无 Key 时不会发送 Authorization，
  注入 `$literal-api-key` 时按字面发送，header `$OPENAI_API_KEY` 不被展开。
- session 路径必须为传入 dataDir 下的 `bots/<botId>/home`、`bots/<botId>/sessions`；
  显式 sessionFile 只能在同一 sessions 目录，拒绝指向外面的符号链接。
  pi JSONL 仍按原生行为延迟创建，允许重开尚未生成的记忆路径。
  `SessionManager.open` 额外传 cwdOverride，恢复文件不能改变 Bot 主目录；
  恢复后明确设置调用者选择的模型和 thinkingLevel。
- 静态资源列表全部为空，关闭工具、安装遥测、cache warming、自动 compaction 和自动 retry。
  pi 会在自有 systemPrompt 后追加 `<cwd>` 段，这是 1.1.0 的原生行为。
- `prompt` 从 `message_end` 或本轮最终 assistant message 取得 stopReason/usage；
  错误或取消会抛 `AgentError`，其 message 只有错误码，不回传 SDK 原始诊断和请求头。
  `no_model` 来自可用模型状态，不能用 `unknown` 占位模型判断。
- 厂商分组沿用附录 B，Azure id 使用已核实的新名 `azure`，新增厂商归 `other`。
  Anthropic 的 API Key 和 Claude Pro/Max 是两个目录行，使用 `(id, auth)` 区分；
  运行时按 provider id 去重，不影响 API Key 可用性。

正式回归测试见 `src/*.test.ts`：临时 HOME、假 auth.json/环境变量、不变的外部 `.pi`、
无 ADC/技能扫描、无真实网络与子进程；流式、abort、错误映射、Key 刷新、会话重开、
HTTP 请求与 SSE 客户端均用测试替身或 fetch stub。probe 继续作为开发调查工具保留。

## 工具接入（2026-10-09）

OpenSessionOptions.localTools 注入自有 LocalToolPorts，六工具/审批/执行状态由 brain 提供；有端口时 noTools:builtin，无端口保留首版的 all。extensions/load.ts 在 sanitize 后动态导入，按既定决定只调用 DefaultResourceLoader 的私有 loadExtensionFactories，核 errors/三扩展身份/policy handler 后交 static ResourceLoader，显式 bindExtensions({})，不 reload/扫描。

pibot-tools 以 sequential 注册并消费绑定 ID/工具/参数的单次许可；pibot-policy 为唯一 tool_call 闸门；pibot-activity 处理执行事件与结果脱敏。1.1.0 的未知工具/参数错误/阻止会跳过 tool_result，额外 message_end 钩子在 JSONL 保存前净化 toolResult 错误，避免完整参数正文回显。此节覆盖上表首版的生产接入方式，P10 仍是历史探路结论。十分钟等待/取消已实测；安装包、Electron/系统隔离未在本任务验收。

## 第二轮摸底（2026-10-10）

锁定 `pi-ai` / `pi-coding-agent` **1.1.0**，Node 26.11.1、pnpm 10.28.2，
调查基线 HEAD `2ec2bab4f58e5128b39f98a595cf280218ff4bfa`。
本节是源码核实、合成探针和后续接线建议；**当时生产代码仍只支持 API Key 认证与私聊**，
`src/credentials.ts` 仍拒绝 OAuth / provider env，`AgentRuntime` 尚无登录、群上下文或队列端口。
没有修改业务实现、依赖、锁文件、协议、存储、迁移或既有测试。

### 证据与公开边界

- 入口及导出由安装包 `package.json.exports`、`dist/index.d.ts` 核实，行为查同版本 `.js`。
  npm 包来源是 `@earendil-works/pi-ai@1.1.0` 与 `@earendil-works/pi-coding-agent@1.1.0`；
  下列 `dist/...` 是源码证据路径，**不是允许生产代码深层 import 的清单**。
- `pi-ai` 主入口公开 `CredentialStore`、`InMemoryCredentialStore`、`OAuthCredential`、
  `AuthInteraction`、`Provider`、`ApiKeyAuth`、`AuthResult`、`createModels`、`createProvider`；
  coding-agent 主入口公开 `ModelRuntime`、`SessionManager`、扩展事件和工厂类型。
- `@earendil-works/pi-ai/oauth` 仍是空运行时入口；不使用旧 `getOAuthProviders()`、
  私有 AuthStorage 或 `dist/auth/oauth/*` 导入。登录通过 `runtime.login` 或
  `runtime.getProvider(id)!.auth.oauth!.login`，后者由调用方负责保存凭据和刷新目录快照。
- 唯一私有桥仍是 `DefaultResourceLoader.loadExtensionFactories(runtime)`；
  钩子探针仅沿用此桥及三个 `pibot-*` 内存工厂身份，没有 `reload()` 或磁盘发现。
  后续接入将钩子和新工具装进现有受控工厂，继续检查身份、错误和 policy handler。

### 订阅 OAuth：入口、交互和令牌

公开调用：

```ts
await runtime.login(providerId, "oauth", interaction, { agentName: "Pi Bot" });
await runtime.logout(providerId, { signal });
await runtime.getAuth(providerId, { signal, minOAuthValidityMs: 5 * 60_000 });
```

`AuthInteraction` 为 `{ signal?, prompt(prompt): Promise<string>, notify(event): void }`。
`prompt.type` 为 `text | secret | select | manual_code`，select 返回选项 id；
`notify.type` 为 `info | auth_url | device_code | progress`。
device_code 有 `userCode, verificationUri, intervalSeconds?, expiresInSeconds?`。
必须同时处理整次登录的 signal 和单个 prompt.signal；回调胜出会取消仍在等待的手工输入。
`LoginOptions.getDeviceId?: () => string` 是公开选项，但这三家调查流程不使用它；
Codex 浏览器流程使用 `agentName` 作为 originator，不能宣传为任意客户端 ID 配置入口。

| provider id / 公开 OAuth handler | 登录流程及回调 | 凭据与刷新 |
|---|---|---|
| `anthropic` / `provider.auth.oauth` | select `browser` / `copy_code`；PKCE S256；`https://claude.ai/oauth/authorize`。browser 监听默认 `127.0.0.1:53692/callback`，占用后尝试端口 0，再失败转手工输入；redirect URI 使用 `localhost`。copy_code 不开 listener，redirect 为 `https://platform.claude.com/oauth/code/callback` | `{type:"oauth", access, refresh, expires}`；expires 为毫秒时间戳，服务端有效期减 5 分钟。POST `https://platform.claude.com/v1/oauth/token`；刷新 body 为 `grant_type:"refresh_token", client_id, refresh_token`，返回轮换后的 access/refresh；`toAuth` 返回 `{apiKey:access}` |
| `openai-codex` / `provider.auth.oauth` | select `browser` / `device_code`。browser 在 `https://auth.openai.com/oauth/authorize` 用 PKCE S256 与独立随机 state；固定 `127.0.0.1:1455/auth/callback`，redirect 固定 `http://localhost:1455/auth/callback`；占用后仅手工输入，不改端口 | 同上且有 `accountId`，来自 access JWT 的 `https://api.openai.com/auth.chatgpt_account_id`；expires 为 Date.now + expires_in 秒，没有先减 5 分钟。POST `/oauth/token`，authorization_code / refresh_token 均用 form-urlencoded；`toAuth` 为 `{apiKey:access}` |
| `github-copilot` / `provider.auth.oauth` | 先 text 提示 Enterprise domain，空值为 github.com；POST `https://github.com/login/device/code`，展示验证码和 verification URI，轮询 `/login/oauth/access_token`；**不开本地回调，不使用 browser state** | `{type:"oauth", access, refresh, expires, enterpriseUrl?, availableModelIds}`。refresh 实际是 GitHub access token，access 是短期 Copilot token；GET `https://api.github.com/copilot_internal/v2/token` 用 refresh 作 Bearer，expires_at×1000 减 5 分钟；刷新还 GET `/models`。`toAuth` 返回 apiKey 及从 token `proxy-ep` 派生的 baseUrl |

Codex 设备码：POST `https://auth.openai.com/api/accounts/deviceauth/usercode`
得到 `device_auth_id, user_code, interval`；轮询 `/api/accounts/deviceauth/token`
得到 `authorization_code, code_verifier`，再 `/oauth/token` 交换，redirect 为
`https://auth.openai.com/deviceauth/callback`。SDK 设备期限 15 分钟；brain 应另加 5 分钟上限。
Copilot 设备期限由响应 `expires_in` 决定，SDK 首次轮询先等待；两家最小轮询间隔 1 秒，
`slow_down` 会延长，取消会清睡眠定时器。设备码不是 refresh token，不要混为一个字段。

Anthropic state 为 PKCE verifier；Codex 为独立随机 16 字节十六进制串。
SDK listener 严格校验 state、路由和 GET；成功回调用单次 claim 防重放。
**手工输入只有在带 state 时才校验**，裸 code 也被 SDK 接受；Pi Bot 应从 auth_url 捕获
本轮 state，要求完整 redirect URL 或 `code#state`，自己拒绝缺失/错误 state 后再交 SDK。
不要记录授权 URL、code、verifier、device code、access/refresh、JWT/accountId 或原始错误 body。

SDK 两个 browser handler 都没传 callback `timeoutMs`；没有自动 5 分钟关闭。
brain 提供 `AbortSignal.any([用户取消/关闭, AbortSignal.timeout(300_000)])`，
prompt 必须响应取消；handler finally 关闭 listener。bind 过程的取消竞态、连接耗尽仍需接入时验证。
interaction.notify 必须不抛错：Codex 的 auth_url notify 在 callback cleanup 的 try/finally 之前；
浏览器打开/事件发送失败要转换成安全状态并取消 controller，不能让异常绕过 listener 清理。
`PI_OAUTH_CALLBACK_HOST` 可改变监听地址：Anthropic 在 OAuth 模块首次加载时读取，
Codex 每次读取；接入时必须在首次懒加载前清除此继承项，保证默认只绑定 127.0.0.1。
现有 `sanitizeBrainEnv` 没清这一项，不能认为现有清理已覆盖新增 OAuth 的所有环境入口。

Copilot 登录会读取模型目录，对 `unconfigured` 模型还可能 POST `/models/<id>/policy`
自动启用模型；探针的合成目录全部为 enabled，**未触发此写入**。
接入时须说明外部账户影响并纳入审计，不能把登录当作纯只读请求。
Copilot token 派生的 baseUrl、Enterprise domain、verification URI 都是边界输入，
需要 schema、协议/host 约束；SDK 只保证验证码 URI 为 http(s)，不自动满足 Pi Bot 的接收方边界。

### 自有 CredentialStore、加密与刷新锁

`ModelRuntime.create({ credentials, modelsPath:null, refreshOnCreate:false, allowModelNetwork:false })`
使认证全部交给注入仓储，不创建默认 `auth.json`。`runtime.login` 内部用仓储 modify 保存；
也可显式 `credentials.modify(id, async () => credential, {signal})` 后刷新本地目录。
canonical 结构为 `Credential = ApiKeyCredential | OAuthCredential`：

```ts
type ApiKeyCredential = { type: "api_key"; key?: string; env?: Record<string, string> };
type OAuthCredential = {
  type: "oauth"; access: string; refresh: string; expires: number;
  [key: string]: unknown;
};
```

- brain 持有长期仓储/锁，agent 只拿接口；read 返回独立副本，list 只返回 `{providerId,type}`。
  modify 为按 provider 串行的异步 read-modify-write；返回 undefined 表示**保持原值**，
  删除必须 delete，且 delete/login/logout 与刷新共用锁。SQLite 同步事务里不能 await 网络。
- 全部 OAuth 结构进 SecretStore 加密 JSON；`expires` 可派生到非秘密状态，但不能让 renderer
  读令牌或 CredentialSynchronizationError.credential/cause。每个秘密叶子单独加入脱敏集合，
  多行 JSON 先 schema 校验、紧凑序列化；不放宽普通 API Key 的 `!` / 换行 / 表达式限制。
- SDK **每 provider id 只有一个 Credential**；应用 `(id,auth)` 目录行不自动变成两个仓储槽。
  接入时必须按认证方式绑定仓储命名空间/运行时；API Key 和 OAuth 共存时不能互相覆盖，
  不能给 OAuth runtime 调 `setRuntimeApiKey` 抢占令牌，协议选择方式与存储协调。
- `getAuth` 在有效期不足 5 分钟时，在 modify 锁内再次检查并调用公开
  `provider.auth.oauth.refresh(credential, signal)`，再保存，最后 `toAuth`；失败为
  `ModelsError.code === "oauth"`，保留旧凭据，不回退环境。状态快照 configured 不证明令牌有效。
- 已开始刷新忽略调用方取消，只受 SDK **15 秒**刷新期限约束，以免丢掉已轮换的 refresh token；
  调用方仍可立即取消等待。仓储要保留锁和落库任务到完成，brain 关闭先排空这些任务再关 DB。
  所有会话使用同一 backing store/锁，不能每次创建互不相知的 literalCredentials。
- 若需主动刷新，brain 定时调用 `getAuth(id,{signal,minOAuthValidityMs:...})`，不另起无锁 refresh。
  minOAuthValidityMs 实际下限为 5 分钟，不能用 0 关闭；Anthropic/Copilot expires 已减 5 分钟，
  默认解析可能在真实过期前约 10 分钟刷新。定时器有上限、退避和 stop/dispose，不无限重试。
- `CredentialSynchronizationError` 表示凭据已经变更但目录快照同步失败；重试同步，
  不盲目重复登录或撤销令牌。SDK 原始 cause 可能含令牌响应，不可直接日志/IPC 返回。

### 四云厂商：逐字段注入路径

`ProviderConfigInput` 公开字段含 `baseUrl, api, headers, apiKey, models, streamSimple, oauth`，
**没有通用 cloud config 或 env 属性**。不要把多字段塞进 apiKey，或猜测 registerProvider 的 config。
公开 `getAuth(id|model,{apiKey?,env?,signal?,minOAuthValidityMs?})` 返回
`AuthResult = {auth:{apiKey?,headers?,baseUrl?}, env?, source?}`。
`ModelRuntime.stream/streamSimple/completeSimple` 会把 `AuthResult.env` 合到请求 options.env；
`createAgentSession` 的 stream 也走此 runtime。仅调用 getAuth 一次不会为之后 prompt 保留 override。
`createModels({authContext})` 可注入环境/文件查询，但 `CreateModelRuntimeOptions` 没有这个字段；
不要把它当成 coding-agent runtime 的注入选项，使用公开 native provider 认证适配器。

推荐接入时用 `registerNativeProvider({...provider, refreshModels:undefined, auth:{apiKey:自有适配器}})`：
`check` 只读脱敏配置/has，`resolve` 返回本次解密得到的字面 auth/env，不向 process.env 写凭据，
并保留 native 模型和 stream 行为。仍须先替换 Vertex 再刷新，未选择 Profile/ADC 时不探文件。
OAuth 保留对应 oauth handler，不能像首版统一替换为禁用的 apiKey resolver。

| 厂商 | 表单 → 实际 SDK 字段 | 字面注入与限制 |
|---|---|---|
| `amazon-bedrock` 密钥 | Access Key ID → `env.AWS_ACCESS_KEY_ID`；Secret → `env.AWS_SECRET_ACCESS_KEY`；Session Token → `env.AWS_SESSION_TOKEN`；地区 → `env.AWS_REGION`（另支持 AWS_DEFAULT_REGION / BedrockOptions.region） | 自有 resolver 返回 `{auth:{},env:字段}`；**不用 apiKey**，那会启用 bearer-token 认证。native stream 把三项转成 AWS client.credentials，使用 SigV4；AK 与 profile 互斥。内置 auth resolver 不读取 stored.env 内的 AK/Secret，只有 getAuth 的 scoped override 会进入 ctx.env；只存 ApiKeyCredential.env 不够 |
| `amazon-bedrock` Profile | profile → `env.AWS_PROFILE` / BedrockOptions.profile；地区同上 | native stream 传 AWS SDK client.profile，随后走默认 credential chain；options profile 优先于 AK。未配 region 可能回退 us-east-1，模型 inference-profile ARN 中地区又优先于显式地区；接入时必须显示/检查实际地区，不暗中靠默认值 |
| `google-vertex` 服务账号文件 / ADC | project → `env.GOOGLE_CLOUD_PROJECT`（备用 GCLOUD_PROJECT / GoogleVertexOptions.project）；location → `env.GOOGLE_CLOUD_LOCATION` / options.location；文件 → `env.GOOGLE_APPLICATION_CREDENTIALS` | 返回 `{auth:{},env:字段}`；**不用假 apiKey**，否则切到 Vertex express API-key 分支。native stream 只转为 GoogleGenAI.googleAuthOptions.keyFilename；未给文件则走 Google ADC。粘贴的内存 JSON 没有 native stream 对应字段，见待决定 |
| `azure` | Endpoint → `env.AZURE_OPENAI_BASE_URL`；API Key → `auth.apiKey`；版本 → `env.AZURE_OPENAI_API_VERSION`；模型映射 → `env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP`，串格式 `model=deployment,model2=deployment2` | resolver `{auth:{apiKey},env:字段}`；也有 AzureEndpointOptions.azureBaseUrl/azureResourceName/azureApiVersion/azureDeploymentName。Azure host 根路径规范化为 `/openai/v1`，默认版本 v1；mapping 保留 catalog model.id，改变实际 payload.model。校验模型/部署名不含 `,` / `=`，不直接拼用户输入；Responses 已验证，completions 的版本行为需另验 |
| `cloudflare-workers-ai` | Account ID → `env.CLOUDFLARE_ACCOUNT_ID`；API Token → `auth.apiKey` | native stream 用 account 替换 model.baseUrl 的占位符，发 Bearer token；workers-ai 不要求 Gateway ID |
| `cloudflare-ai-gateway` | Account ID → 同上；Gateway ID → `env.CLOUDFLARE_GATEWAY_ID`；Token → `auth.headers["cf-aig-authorization"] = "Bearer …"` | 使用 native cloudflare auth resolver 可得到这些字段；Authorization 和 x-api-key 必须为 null，避免把 Gateway token发给下游厂商。URL 占位符替换不是 URL 编码，account/gateway 必须先校验为安全路径段 |

读取 AWS Profile / ADC 的**源码路径**（本轮没有读取真实文件）：

- Bedrock 原生 stream 构造 `BedrockRuntimeClient({profile,...})`，AWS SDK 默认链会查
  用户 `.aws/credentials` / `.aws/config`，可继续 SSO、角色、web identity、ECS/IMDS，
  以及 **credential_process 子进程**。provider env 的 AWS_SHARED_CREDENTIALS_FILE /
  AWS_CONFIG_FILE 没被 pi stream 映射为 client filepath/configFilepath，不能冒充完整文件注入。
  推荐初期显式读取/校验用户所选的静态 AK profile，再按上表 scoped AK 注入；
  角色/SSO/credential_process 明确返回不支持，完整 chain 范围先协调，不能默认允许额外命令/请求。
- Vertex 的 pi availability check 固定探 `~/.config/gcloud/application_default_credentials.json`，
  与 Google SDK 的 Windows `%APPDATA%/gcloud`、CLOUDSDK_CONFIG 路径规则不完全一致；
  Google SDK ADC 还可能读环境指定文件、well-known 文件或请求 metadata 服务。
  接入时由三平台适配器在用户主动选择后确定路径，显式 keyFilename 并限制文件 credential 类型；
  默认不发现/探测用户配置，不把“ADC”泛化成允许执行 external-account 命令或 metadata 请求。
- `{env:{}}` 不是隔离：pi 的 `getProviderEnvValue`、AuthContext overlay 对缺失/空串仍回退
  process.env。沿用启动时清理；请求时只传已校验字段，不能用临时 set/delete 环境做并发注入。
  HTTP proxy / CLOUDSDK_CONFIG / callback host 等辅助变量单独审核，别把账户秘密写进 URL/log。

### 群上下文、记忆与会话资源

选定的钩子与锁定 API 一致：

```ts
pi.on("context", (event, ctx) => ({ messages: assemble(event.messages) }));
pi.on("before_agent_start", (event, ctx) => {
  event.systemPromptOptions.sections.pibot_memory = redactedMemory;
});
```

- `context` 每次模型调用前触发（包括一轮多次工具循环），输入 `AgentMessage[]` 不含 system；
  返回 `{messages?: AgentMessage[]}`，SDK 恢复 system 和工具声明。用它注入群公告/角色、
  最近 30 条×500 字摘要、自身线程与任务状态；保留工具调用/结果配对及当前轮新增消息，
  按业务 messageId 去重，不把每次完整 group 快照永久 append 到 pi 历史。
  群服务提供有版本/身份的只读脱敏快照，agent 封装钩子；异步取快照需 run signal + timeout。
- `context_with_system` 也公开，但返回值掌管全部 system/tool 声明；这里不需要它。
  自定义 ResourceLoader 继续承担无扫描的静态资源/受控扩展容器，不作群 DB 或每次 prompt 拼接入口。
- `before_agent_start` 在新用户 prompt 开始时调用，有 `prompt, images?, readonly systemPrompt,
  systemPromptOptions`；可修改 `.sections`，或返回 `{message?,systemPrompt?}`。
  采用 sections 便于独立更新；**section 变化会持久化为 pi system entry**，
  return.message 会成为持久化 custom message；return.systemPrompt 的 force 覆盖则只投影到请求。
  注入前先脱敏，删除或清空记忆后移除旧 section；auto/ask均注入已保存记忆。删除记忆不等于清除历史 JSONL，隐私边界需记录。
- hook 的 `ctx.signal` 在 before_agent_start 等尚未 streaming 阶段可能是 undefined；
  使用 brain 注入的本轮 signal，工具 execute 另有自己的 signal。SDK 会捕获 hook 错误并继续，
  必需身份/权限上下文的准备失败要由外层阻止 prompt，不能仅 throw hook 假定整轮终止。
- `pi.on(...)` 返回取消函数；session.subscribe 同样退订。协作/记忆工具用 registerTool，
  不开内置 bash/read/MCP、不绕 `pibot-policy`；ask 记忆是无期限业务提案，不复用工具审批等待。

`SessionManager.create(cwd,sessionDir)` / `open(file,sessionDir,cwdOverride)` / `inMemory(cwd,options?,entries?)`
均公开。每 `(botId,conversationId)` 独立 JSONL / SessionManager；运行前才打开，结束 dispose，
持久引用交 bot_sessions 仓储。现有 paths 校验仍要求自有 bots/<botId>/sessions，
不能因为群 thread 就放宽到任意文件或共享别的 Bot 的 JSONL；旧 DM 引用由追加迁移负责。

- SessionManager 持有全文件 entries 和 byId 等索引，不常驻文件描述符；JSONL 同步读/解析、
  append/rewrite 时短时打开文件。AgentSession 另有消息投影、监听、工具/扩展、cacheWarmer、重试状态；
  cache warming 必须继续 off。每个会话不是一个进程/模型副本，但历史和图片会增加堆与启动 IO。
- 合成空历史、已热导入、**共享一个 ModelRuntime** 的本机单次样本：1000 个内存 manager
  增堆约 1.38 MB；64 个完整空 session 增堆约 1.16 MB，创建中位 0.102 ms、最大 0.579 ms。
  这是 GC 前后粗测，不是长期容量上限；不含每次独立 runtime、生产工具、图片、大 JSONL、模型请求。
  当前 openSession 每次新建 ModelRuntime；不凭此数据擅自引入全局 runtime 或预建所有群会话。
- 公开 `prompt(text,{streamingBehavior:"steer"|"followUp"})`、`steer`、`followUp` 仅排队
  **同一个 AgentSession**；`pendingMessageCount/clearQueue/getSteeringMessages/getFollowUpMessages`
  可管理 SDK 队列，不能协调同 Bot 跨 DM/群/线程。仍需 brain 级有限、可取消的 Bot 队列。
- `abort():Promise<void>` 请求终止并等待 idle；`dispose():void` 清监听/cache/provider 会话资源，
  不等于异步排空。先取消本轮外部等待/审批/工具，再 await abort/prompt settle，最后 dispose。
  排队 UI 发取消时显式移除 brain 项；必要时 clearQueue，别将 steer 意外送进另一个群。
  `assign_task/ask_bot` 不能持有 Bot 锁等待同 Bot/循环依赖；全局 exec busy 仍要单独调度。

### 待编排者集中决定

以下保留调查时的候选方案。负责人随后已明确选择：允许厂商固定本机回调端口，Vertex公开内存适配器，静态Profile/明确类型ADC及Copilot登录前告知/审计。后续以负责人的决定为准，不采用未选中的临时明文文件方案。

1. **随机端口与原生 OAuth 不一致**：公开 login 无 callback port/redirect override。
   三个可选方案：①批准厂商固定 loopback 端口例外，仍强制 state/5 分钟/清理；
   ②**推荐先保持规格边界**：Anthropic copy_code（强制带 state）+ Codex device_code + Copilot device_code，
   暂不启用固定端口 browser 分支；③向 SDK 增加公开 callback 参数后另行批准版本变更。
   探针用占住 53692 验证了随机 fallback，但这不是生产强制随机端口方案。
2. **Vertex 内存服务账号 JSON**：原生公开 stream 仅支持 keyFilename。
   ①**推荐公开 provider/stream 适配器**，以显式内存 credentials 对象接 Google SDK，
   已核实 `@google/genai@2.21.0` 的 `GoogleGenAIOptions.googleAuthOptions.credentials`
   （GoogleAuthOptions）支持此输入，但需自写公开 stream 适配，不能透传到 pi 原生 stream；
   所需依赖另行声明精确版本；②短期受限权限临时明文文件，需接受崩溃残留风险并补安全清理；
   ③先仅支持用户主动选的文件/ADC，延期粘贴。调查不选定实现，不扩大私有桥。
3. **Copilot 自动启用模型与 Profile/ADC 范围**：确认登录自带账户 policy 写入的告知/审计，
   以及是否先只接受静态 Profile 和确定类型 ADC；完整云 credential chain 不属于已验证能力。

### 实际验证与未验项

临时 Node 探针（未留进仓库、不新增单元测试）只使用合成凭据、内存仓储、静态资源和
127.0.0.1 假服务；远程 socket/HTTP、子进程均拒绝。OAuth 固定网络 URL 被 fetch 适配到
假服务，没有真实浏览器/登录/云请求，也未读真实 Key、`.aws`、gcloud 或 `.pi`。

- 64 项临时断言通过：三家 login/refresh、并发刷新一次、刷新期间取消仍保存轮换令牌、
  state 拒绝/成功回调、Anthropic 随机 fallback、Codex 1455、设备取消；SDK15次 fetch、假服务16次请求。
- Bedrock scoped AK 在本地假 HTTP 服务生成含合成 AK/地区/sessionToken 的 SigV4 请求；
  Azure Responses 捕获版本 query/部署 payload；两 Cloudflare 捕获 account URL。
  这些验证请求组装，故意结束于假响应/捕获错误，**不证明真实云认证或聊天成功**。
- runtime 自有 resolver 的五组 env 传到合成 stream；Vertex 文件存在用 AuthContext 假实现，
  未解析服务账号、访问 token endpoint 或读取 ADC。Cloudflare Gateway headers 的结构由 resolver核实。
- context 未落会话 entries，记忆 section 落 entries；两轮未累加临时群摘要；
  运行中 followUp/clearQueue/abort/idle/dispose 通过，资源粗测边界见上。
- `pnpm check`：冻结安装、typecheck、lint、25 文件/674 既有测试通过。安装只出现已有依赖
  ignored build scripts 提示，无依赖/锁文件变更；没执行 approve-builds。
- 未验证：真实订阅/政策许可、OAuth 5 分钟超时/bind 竞态/三平台端口、真实云/SSO/ADC、
  钥匙串/Electron UI/系统隔离、长历史/图片容量、群业务队列和记忆权限。

## 本地补丁

`patches/@earendil-works__pi-ai@1.6.0.patch` 保留 Pi Bot OAuth 回调页（`dist/utils/oauth-page.js`）的双语、深浅色和清理授权 URL 行为，以及旧 Codex 回调的 GET/state 校验。升级时核对工作区解析到带 `patch_hash` 的对应包，步骤见 [pi 补丁升级手册](../../tools/dev/pi-patch-upgrade.md)。
