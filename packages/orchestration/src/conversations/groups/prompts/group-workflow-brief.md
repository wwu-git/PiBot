# group-workflow-brief

Prompt text used by `group-workflow-brief.ts` (a plan step's brief). Each `## \`key\`` block is sent to the model exactly as written (blank lines around a block are ignored); `{{name}}` is filled in by the code. After editing, run `pnpm gen:prompts`. Changing a block changes the cached prompt prefix (see docs/prompt-cache.md). These lines are appended at the end of a brief, and only to the rerun of a step the group's pause stopped (`contextFull`: only to the retry of a step whose last run stopped because its context was full), so other briefs keep their text. The `summary.*` blocks head the lists Pi Bot builds from its own records of the stopped run (no model call); each list follows its line as `- item` lines.

## `resumed`

这一步因群组暂停被中断，现在继续：暂停期间文件可能有变化（包括用户的修改），继续前先重新读取你要依赖的文件和当前进度，已经完成的部分不要重做。 / This step was interrupted by the group pause and is continuing now: files may have changed during the pause (including by the user). Re-read the files and progress you rely on before editing, and don't redo parts that are already done.

## `resumedLost`

这一步之前在自己工作区里还没合并的改动没能保留，这次从当前的群文件夹开始。 / The unmerged changes this step had made in its own workspace could not be kept; this run starts from the current group folder.

## `contextFull`

上次因一次读入太多内容而停止；大文件先搜索，只读需要的片段。 / The last run stopped because it read too much at once; search large files first and read only the parts you need.

## `summary.files`

上次被暂停停下的运行改过这些文件（Pi Bot 的记录，路径相对于你的工作文件夹）： / Files the stopped run changed (Pi Bot's records; paths relative to your working folder):

## `summary.filesLost`

上次被暂停停下的运行在自己工作区里改过这些文件，这些改动没有保留（路径相对于你的工作文件夹）： / Files the stopped run had changed in its own workspace; those changes were not kept (paths relative to your working folder):

## `summary.commands`

它最近运行的命令和结果（按先后）： / The latest commands it ran and their outcome (in order):

## `summary.others`

暂停期间有人（比如用户）改过这些文件： / Files someone else (for example the user) changed during the pause:

## `summary.more`

…还有 {{count}} 个 / …and {{count}} more

## `summary.earlier`

（之前还有 {{count}} 条） / ({{count}} earlier not shown)

## `summary.exit`

退出码 {{code}} / exit {{code}}

## `summary.done`

完成 / done

## `summary.failed`

失败 / failed

## `summary.blocked`

未运行（被拦下） / not run (blocked)

## `summary.aborted`

已中止 / aborted

## `summary.stopped`

被暂停打断 / stopped by the pause
