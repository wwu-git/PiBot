# 内置角色、技能、群聊模板与职业

随应用打包、离线可用的**只读**内容：只有一小组入门角色和群。完整的官方角色库（全部角色和群聊模板）在独立仓库 [pibot-roles](https://github.com/w01fb0ss/pibot-roles)，经 roles.pibot.space 签名发布，应用里点「安装」时下载。这里每个角色和群必须与 pibot-roles 中的同名目录逐字节相同；`professions.json` 和 `history.json` 两边也相同（职业推荐可以指向只在 pibot-roles 里的角色和群，应用会从角色库安装）。代码只读取这里的文件，运行时不修改它们；用户基于内置内容建出的 Bot 是独立副本，改过的 Bot 不随这里更新。

## 目录

内置内容就是用户导入导出的 `.pibot` 第 3 版文件，**解开成目录**存放（维护者 2026-10-15 决定）。读取它和读取用户的 `.pibot` zip 是同一套代码。

```
builtin/
├── roles/<roleId>.pibot/        一个角色 = 只有 1 个 Bot、0 个群的团队文件（随应用打包 15 个，见 `tools/dev/builtin-minimal.ts`）
│   ├── team.json
│   └── skills/<roleId>/<skillId>/{zh,en}/SKILL.md（可带 scripts/、references/）
├── groups/<groupId>.pibot/      一个群聊模板 = 群 + 成员 Bot + 成员的技能（随应用打包 3 个）
│   ├── team.json
│   └── skills/<roleId>/<skillId>/{zh,en}/…
├── professions.json             欢迎向导的 13 个职业 → 推荐的群聊和角色（只是索引）
└── README.md
```

- team.json 里用户看得到的文字（名字、简介、人设、规范、快捷提问、群名、群公告、欢迎消息、快捷开始、角色名）都写成 `{ "zh": "…", "en": "…" }`，两种语言都必须有；按界面语言取一份。
- 每个 Bot 的 `ref` 等于 `role.id`；同一个角色在 `roles/` 和各个 `groups/` 目录里的条目和技能文件必须**逐字节相同**（`pnpm lint` 会检查）。
- **改角色只改 `roles/<roleId>.pibot/`**，然后运行 `pnpm builtin:pack sync`，把它同步进所有包含这个角色的群聊目录；`pnpm builtin:pack check` 单独做一遍检查。
- 要点：
  - `avatarShape` / `avatarColor` / `avatarEyes` 只能用 `packages/brain/src/conversations/bots/avatars.ts` 里的取值；22 个角色的「外形 + 颜色」互不相同，也不和 Pi（blob + violet）相同。
  - `permissionOverrides` 通常只能是 `"ask"` 或 `"never"`；随包内置角色可以用 `run_command: "always"`（隔离内命令直接运行，非包仓库联网、安装、后台和目录外写仍确认）。用户导入仍收紧，不能借此获得 always；已有 Bot 显式 ask/never 保守保留。键是 `packages/protocol` 的 `CategorySchema`，不能有 `network`；通用助手为空对象。另可写 `"confirmEverySend": true`（不是权限档位）：这个 Bot 每次对外发送都要用户确认，记住的授权、连接同意、例行任务预授权和 YOLO 都不能代答，卡片也不提供「记住」；一人公司的幕僚长、财务、运营、客服带这个标记。它不进版本指纹，已建的 Bot 不会因「采用新版」获得或失去它。`model` 一律为 `null`（用默认模型）。
  - `skills` 写 `{ "folder": "<skillId>", "enabled": true }`，内容在 `skills/<roleId>/<skillId>/`；通用助手没有默认技能，其余角色 2–3 个。图片角色的技能不会复制给 Bot（图片 Bot 的对话不经过系统提示和 read_file），所以生图设计师名下的两个技能（`image-prompt-writing`、`image-brief`）是给文字角色（新媒体运营、视频脚本）写配图需求时参考的模板，图片运行既读不到也不用它们。
  - 群聊 `members` 2–6 个，统筹排第一个，统筹不能是图片角色（`"category": "image"`）；`template.id` 等于目录名。
  - `professions.json` 的 `icon` 是语义名（code、lightbulb、palette、pen、megaphone、chart、book、school、cart、briefcase、server、rocket），由界面映射到自己的图标，没有对应图标时用通用图标。
- `SKILL.md` 的 frontmatter 和应用自己写技能时一致（`packages/brain/src/skills/skill-format.ts`）：`name` 等于目录名，`description` 是一行，显示名放 `metadata.pibot-name`，参数放 `metadata.pibot-params`（JSON 字符串）。正文里的 `{参数}` 必须在 `pibot-params` 里声明；其他花括号不要用，以免模型误当成参数。
- 技能里的脚本只用标准库、不联网、不安装东西、只读输入；结果写到工作文件夹。目前只有 `csv-profile` 带脚本（Python 3 标准库）。技能目录对 Bot 只读，运行脚本照常经过命令审批。

- 非工程角色默认 low，工程与审查角色默认 medium，图片角色 off；创建和导入保留角色值并按目标模型能力收敛，无推理能力时为 off。
- 导师带面试式练习（`interview-drill`）和复习计划（`study-plan`）两个技能，不运行命令；练习是一问一答、不建计划，跨几天的复习才用它排表并建议建例行任务。学习组由导师和研究员组成：研究员只带资料笔记与事实核查两个技能（群里可以只带角色技能的一部分，见下一节），轻量开发组由全栈、测试和审查组成。
- 群里的角色可以只带角色技能的一个子集：`team.json` 的 `skills` 列了哪些就带哪些，`pnpm builtin:pack sync` 只复制这些目录，其余内容仍与角色一致；角色在群里带着的版本之后新增的技能会自动补进来，所以新技能加进角色后会随 sync 到达已有群。检查器按子集逐目录比较副本。
- 图片运行：没有文字模型这一步，程序把「质量指导 + 这个 Bot 的工作规范（最多约 2000 字，按行截断）+ 出图规格清单 + 用户请求」拼成一条提示交给图片模型，不多调一次模型。规范取 Bot 上的副本（用户可改），所以改角色规范只影响新建或「采用新版」的 Bot。技能文件仍不读取：出图规格在程序侧只有一份，位于 `packages/images/src/brain/run/image-quality-prompt.ts`（用途与比例、主体、构图、风格色彩光线、画面文字、不要出现）；要改图像流程的实际要求，得同时改这份清单和生图设计师的规范（`roles/image-designer.pibot/team.json` 的 `norms`，已建 Bot 有自己的副本）。每次真实生成都先弹付费确认卡（与权限级别、群设置、公告文字无关，见 `packages/policy` 的 `paid_generation_confirmation`）；YOLO 不放行，只有卡上的「这个 Bot 用这个模型不再问」（`paid_image` 授权）或例行任务的付费预授权能跳过（维护者 2026-10-23）。
- 加载检查覆盖双语规范、人设行数、重复规范、群结构与公告长度；跨角色校验头像、共享技能副本及思考档位，五个以上角色重复规范只告警（不输出正文）。

## 版本

- 每个角色（`role.version`）和群聊模板（`template.version`）有自己的版本号（从 1 开始的整数）。**内容有任何改动（人设、规范、技能列表、权限、快捷提问、群公告、欢迎消息、成员）都要把这个文件的 `version` 加 1。** Bot 和群记下的是 `{ id, version }`，以后据此提示「模板有新版本」。
- 改了某个技能的内容时，先把这个技能 `SKILL.md` 的 `metadata.pibot-version` 加 1（没有就写 `"1"`；技能内容变了版本没变 `pnpm lint` 会失败），再把**引用它的每个角色**的 `version` 加 1。带工作合同的技能另有 `metadata.pibot-contract`（JSON 字符串，格式由 `pnpm builtin:pack check` 校验），检查器对合同无效报错，对正文超过 60 行、停止规则超过 3 条告警。
- `id` 一旦发布就不改；要换掉一个角色或模板，新建一个 id，旧的保留到下一次清理。
- `professions.json` 没有版本号，只决定推荐什么，不影响已建好的 Bot。
- `history.json`：每个角色 / 模板每个已发布版本的指纹（规范、公告、技能内容的短哈希，以及权限、思考强度、成员、轮次的取值），不含正文。已建的 Bot / 群据此判断哪些内容还是旧版内置值、「采用新版」时可以更新。`pnpm builtin:pack sync` 会把当前版本记进去；内容改了却没加版本号时它会提示，`pnpm lint` 发现当前内容不在记录里会失败。`pnpm builtin:pack history` 从 git 历史整份重建（一次性 / 修复用）。

## 写作约定

- 人设 ≤ 8 行（身份、性格、擅长）；工作规范 10–15 条，每条是能改变做法的具体要求。长流程放技能，用到时 Bot 才用 `read_file` 读。
- 规范和技能**从不**声称拥有权限，也不教 Bot 绕过审批；涉及写文件、运行命令、对外发送时按当前权限模式处理，不承诺每次弹窗或免审批。
- 群公告写清分工、交接和规则（含同一文件夹同一时间只有一个成员写；有图像成员的群另写明「图片按需请求，不作为计划步骤」，图像成员只按需交办，不占计划步骤）；为了在上下文紧张时不被截断，每种语言控制在 500 字符以内。欢迎消息是统筹 Bot 的固定文案，不调用模型，提成员时写角色名而不是默认昵称（用户可能改名）。
- 中英文逐条同义、各自自然；规范只写角色特有的方法，不重复系统提示中的共用权限、执行和交付规则。

## 来源与许可

- 这里的全部文字和脚本由 Pi Bot 项目原创编写（Claude，2026-10-15），随本仓库的许可发布。
- 写作时参考过 WorkBuddy「专家」市场里对应职业的专家定义，**只用来了解一个好的角色定义应该覆盖哪些方面**；没有复制其中的任何句子、结构、名字、头像或文件。
- 没有改编任何第三方开源内容，因此没有附带的第三方许可声明。以后如果改编开源内容（如 MIT 的 agency-agents、Apache-2.0 的 anthropics/skills），必须从原始仓库取，并在这里逐项写明：文件 → 原始仓库与路径 → 许可证 → 改动说明，同时把许可证全文放进 `builtin/licenses/`。
