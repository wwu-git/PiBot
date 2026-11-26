# Policy 判定矩阵

修改 `packages/policy` 后跑 `pnpm probe:policy`；合并门禁的 `check:no-install` 也会运行。
探针调用真实 `createPolicy().evaluate()`，标准输出是 TSV。每格固定为 `decision:reason`；
预期表不一致，或拒绝的判定链缺少该检查码，进程退出非零。

`expected.tsv` 是按现有规则编写的审查基线。权限行为确需变化时，按规则审查受影响的格子并
手动更新，不能直接把探针输出覆盖到预期表。每个类别有一条代表请求；只对适用的类别增加
工作位置内外、保护路径、技能与解释器环境、记忆、网络及解析失败等变体。原生类别没有可调
权限时，三档用来确认它不会被其他权限开关影响。远端缺少路径解析能力用合成快照覆盖。

`script/*`、`run_command/{node,lua,php,ruby,curl}_*` 和 `routine/*` 行来自 `scripts.ts`：脚本内容放在
内存表里，读取时写入临时文件再经真实的 `nodeFileSystem.readScript`（大小与普通文件检查是真的）；
`routine/*` 的格子末尾是例行任务卡能给出的预授权（`none` / `pinned` / `programs`），
`routine/script_changed` 是同一脚本内容不变与改动后，原预授权是否还匹配。
`send_out/bot_*` 是以 Bot 身份发送：记住的发送对象或 YOLO 会放行；带 `confirmEverySend` 的 Bot（`send_out/*_confirm_every`）
在 ask / always 档都必须是 `ask:bot_send_confirmation`，且不能提供「记住」。
`script/c1_*`…`script/low_*`、`script/n1_*`、`script/n4_*` 和 `routine/m1_*` 是 2026-11-20 三轮安全审查的复现：在 ask 档必须是
`ask`、预授权必须是 `none`；`script/c2_python_c_isolated` / `_clean` 是对照（`-I` 或干净的 cwd 仍可放行）。
目录列表（Python 同名模块检查）也来自内存表。

三平台分支共用合成路径解析和隔离探测结果；命令分析器和策略是真实实现，不运行命令、不访问
网络或用户文件。它不验证真实操作系统隔离、远端 RPC、审批窗口或某个工具的执行副作用。
