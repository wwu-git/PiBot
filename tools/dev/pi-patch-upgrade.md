# Upgrading pi with the add-only patches

Pi Bot applies three upgrade-related patches. The `pi-coding-agent` patch is **add-only**
(new files and `exports` keys) so it re-applies cleanly on new versions.

| Package | What the patch adds |
|---|---|
| `@earendil-works/pi-coding-agent` | `dist/sdk.js` + `.d.ts` (headless SDK entry without `modes/*`), `dist/version.js` + `.d.ts`, `dist/truncate.js` + `.d.ts`, generated `dist/context-helpers.js` and `dist/async-session.js` with their declarations, and the five matching `exports` keys |
| `@earendil-works/pi-ai` | OAuth GET/state check, Pi Bot callback page, and the `./env-api-keys` export |
| `@google/genai` | Preserve errors carried by successful HTTP streams for every CJS/ESM/browser entry |

## Steps for a new pi version `X`

1. Bump the exact versions of all `@earendil-works/*` packages in `packages/agent/package.json` and `apps/desktop/package.json` (no `^`). Match their exact GenAI version to pi-ai.
2. For each patched package: `pnpm patch <package>@<version> --edit-dir <tmp>`, then re-create the
   changes listed above in `<tmp>` (copy the new files from the old patch; re-add the `exports` keys).
   For GenAI, preserve named SSE errors and the pre-check for `data.error` before the SDK's generic
   error parser, as well as the check before model-response conversion. Compare all five dist files.
3. Check every re-export in `dist/sdk.js` still points at an existing module and name (`grep` the new
   `dist/index.js` for each name; the root entry lists where they live). Same for `truncate.js` and
   `version.js` (`VERSION` from `./config.js`).
4. `pnpm patch-commit <tmp>`; delete the old `patches/*@<old>.patch` if pnpm did not.
5. `pnpm install --frozen-lockfile` must pass (a patch that no longer applies fails here), then
   `pnpm check:changed main`. Run `pnpm verify` in the integration phase. Re-run the existing
   `google-stream-error.test.ts` against the same patched GenAI version that pi-ai resolves.
6. Re-check the startup module graph: importing `packages/agent/src/index.ts` must not load
   `typebox`, `highlight.js`, `@earendil-works/pi-tui` or pi-coding-agent beyond `version`/`truncate`.

If upstream ships a headless entry, switch
`packages/agent/src/runtime/pi-sdk.ts` to it and drop the patch.

The `./async-session` entry reads saved JSONL in batches and yields between parsing batches. It
uses the pinned SDK constructor with preloaded entries and the original persistence path. Before
changing the generator's source hash for an SDK upgrade, verify the parser, constructor signature,
and migration behavior against the new packaged SDK.

```sh
node packages/agent/scripts/pi-async-session.ts --source packages/agent/node_modules/@earendil-works/pi-coding-agent --output .pibot-dev/async-session.js
```

Compare the generated files with the patched package. Recheck truncated and malformed JSONL,
missing and legacy sessions, cancellation, and large-session callback timing. A single very large
JSON record and SDK migration/indexing can still run synchronously.

版本窄入口不得重导出 `config.js`（它会在环境清理前读包路径配置）。升级时 `dist/version.js` 常量必须与锁定依赖的 package.json.version 相同，d.ts 保持 string；同时核对 diff 不含 deleted file mode、重命名或任何原有代码删除，不能只数以减号开头的内容行。

## 无状态 context-helpers 的生成出处

`packages/agent/scripts/pi-context-helpers.ts` 从锁定 pi-coding-agent 1.6.0 的三个原 dist 文件逐字抽取 12 个纯函数（241 行）和一个不可变数值常量，只改变辅助函数的 export 可见性，不改函数体。生成代码零 import / I/O / 环境读取 / 可变模块状态；类型重导出原 API。原 SDK 文件与完整入口不改。不要把它或 ./sdk 入口称为完全 headless，动态 SDK 的 core 仍可能引入 theme/TUI。

生成命令（先用当前工作区精确安装包路径）：

```sh
node packages/agent/scripts/pi-context-helpers.ts --source packages/agent/node_modules/@earendil-works/pi-coding-agent --output .pibot-dev/context-helpers.js
```

输出同时带三个源文件的 SHA256 与函数名清单，放入 add-only 补丁的 dist/context-helpers.js；重新安装后须与生成结果逐字一致，再用 ignored 探针对同输入比较上游 SDK 的 projection/token 返回值，核对入口零 import 和启动图不含 TUI/config。新版本或编译输出格式变化时生成器明确失败，需要重新核闭包，不能手工近似实现。SDK 装载器只做 dynamic import，复用 ESM 内置缓存，不另设 loaded/loading 全局。
