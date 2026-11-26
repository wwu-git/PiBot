#!/usr/bin/env bash
# 第三层评测：一条命令跑完「改动前 / 改动后」两组真实模型评测，最后出对比表。
#
#   bash tools/dev/eval-ab.sh              # 跑对缺的那一组，再出表（已有 10 条结果的组自动跳过）
#   bash tools/dev/eval-ab.sh --trial      # 每组先用 1 条试探，通不过就停（多花 2 次调用）
#   bash tools/dev/eval-ab.sh --reinstall  # 改动前那份代码重新 pnpm install
#   bash tools/dev/eval-ab.sh --skip-after # 只跑改动前
#
# 需要环境变量 PIBOT_EVAL_API_KEY。密钥不进命令行、不进日志。
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BEFORE_DIR=${PIBOT_EVAL_BEFORE_DIR:-/private/tmp/pibot-before}
RESULTS=${PIBOT_EVAL_RESULTS:-/private/tmp/eval-results}
AFTER_DATA=${PIBOT_EVAL_AFTER_DATA:-/private/tmp/eval-after}
BEFORE_DATA=${PIBOT_EVAL_BEFORE_DATA:-/private/tmp/eval-before}
SUITE=${PIBOT_EVAL_SUITE:-tools/dev/eval-suite.json}
MODEL=${PIBOT_EVAL_MODEL:-deepseek/deepseek-v4.1-flash-1017}
BASE_URL=${PIBOT_EVAL_BASE_URL:-https://openrouter.ai/api/v1}
API_TYPE=${PIBOT_EVAL_API:-openai-completions}
TIMEOUT=${PIBOT_EVAL_TIMEOUT:-180}
# Commit used as "before" (default HEAD, i.e. working tree vs last commit).
BEFORE_REF=${PIBOT_EVAL_BEFORE_REF:-HEAD}

SKIP_AFTER=0
SKIP_BEFORE=0
TRIAL=0
REINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-after) SKIP_AFTER=1 ;;
    --skip-before) SKIP_BEFORE=1 ;;
    --trial) TRIAL=1 ;;
    --reinstall) REINSTALL=1 ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数 / unknown flag: $arg（--help 看用法）" >&2
      exit 2
      ;;
  esac
done

KEY=${PIBOT_EVAL_API_KEY:-}
if [ -z "$KEY" ]; then
  echo "缺少密钥：先 export PIBOT_EVAL_API_KEY=..." >&2
  exit 1
fi
export PIBOT_EVAL_API_KEY="$KEY"

# 删除前统一校验：下面每个目录都能被环境变量覆盖，写错一次就找不回来了。
assert_safe_to_delete() {
  local target
  for target in "$@"; do
    node -e '
      const path = require("node:path");
      const [p, home, root] = process.argv.slice(1);
      const fail = (why) => {
        console.error(`拒绝删除 / refusing to delete ${p}: ${why}`);
        process.exit(2);
      };
      if (!path.isAbsolute(p)) fail("不是绝对路径 / not an absolute path");
      const abs = path.resolve(p);
      if (abs.split("/").filter(Boolean).length < 3)
        fail("层级太浅 / too close to the filesystem root");
      for (const [name, dir] of [["HOME", home], ["仓库根 / repo root", root]]) {
        const base = path.resolve(dir);
        if (abs === base || base.startsWith(`${abs}/`)) fail(`是${name}或其上级 / is or contains ${name}`);
      }
    ' "$target" "$HOME" "$ROOT" || exit 2
  done
}

safe_rm() {
  assert_safe_to_delete "$@"
  rm -rf -- "$@"
}

assert_safe_to_delete "$BEFORE_DIR" "$AFTER_DATA" "$BEFORE_DATA" "$RESULTS"

mkdir -p "$RESULTS"

count_results() { # $1 = group
  { ls "$RESULTS"/"$1"-*.jsonl 2>/dev/null || true; } | wc -l | tr -d ' '
}

task_count() { # $1 = dir holding the suite
  node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).length)' \
    "$1/$SUITE"
}

GROUP_CODE=0
TRIAL_FAILED=0
AFTER_CODE=0
BEFORE_CODE=0

run_group() { # $1 = cwd, $2 = group, $3 = data dir; sets GROUP_CODE, TRIAL_FAILED
  local dir=$1 group=$2 data=$3 code=0
  GROUP_CODE=0
  if [ "$TRIAL" = 1 ]; then
    echo "== $group 组试探 1 条（确认密钥/端点/写盘）"
    ( cd "$dir" && node tools/dev/eval.ts run --suite "$SUITE" --data "$data" --out "$RESULTS" \
      --group "$group" --base-url "$BASE_URL" --model "$MODEL" --api "$API_TYPE" \
      --timeout "$TIMEOUT" --limit 1 ) || code=$?
    # 试探那一轮会留在会话里，正式跑之前清掉，否则两组轮次不一致。
    safe_rm "$data"
    if [ "$code" != 0 ]; then
      echo "== $group 组试探未通过（exit=$code），先停，不再往下烧调用" >&2
      # 试探失败是“端点/密钥根本不通”，后面那组也不用试了。
      TRIAL_FAILED=1
      GROUP_CODE=$code
      return 0
    fi
  fi
  echo "== $group 组开跑：$(task_count "$dir") 条"
  ( cd "$dir" && node tools/dev/eval.ts run --suite "$SUITE" --data "$data" --out "$RESULTS" \
    --group "$group" --base-url "$BASE_URL" --model "$MODEL" --api "$API_TYPE" \
    --timeout "$TIMEOUT" ) || code=$?
  # 数据目录里存着明文密钥：结果已经落成 jsonl，跑完（含失败）就删掉。
  safe_rm "$data"
  # 单条任务没通过不该拦着另一组和对比表：记下退出码，交给最后统一报告。
  GROUP_CODE=$code
  return 0
}

echo "模型 $MODEL @ ${BASE_URL}（${API_TYPE}），结果目录 $RESULTS"

if [ "$SKIP_AFTER" = 0 ]; then
  if [ "$(count_results after)" -ge "$(task_count "$ROOT")" ]; then
    echo "== 改动后已完成 $(count_results after) 条，跳过（要重跑就删 $RESULTS/after-*.jsonl）"
  else
    safe_rm "$AFTER_DATA" "$RESULTS"/after-*.jsonl
    run_group "$ROOT" after "$AFTER_DATA"
    AFTER_CODE=$GROUP_CODE
    if [ "$TRIAL_FAILED" = 1 ]; then exit "$AFTER_CODE"; fi
  fi
fi

if [ "$SKIP_BEFORE" = 0 ]; then
  if [ "$(count_results before)" -ge "$(task_count "$ROOT")" ]; then
    echo "== 改动前已完成 $(count_results before) 条，跳过（要重跑就删 $RESULTS/before-*.jsonl）"
  else
    echo "== 生成改动前的代码：$BEFORE_DIR"
    # 保留 node_modules，--reinstall 才是真的“重装”，而不是每次都重装。
    if [ -d "$BEFORE_DIR" ]; then
      assert_safe_to_delete "$BEFORE_DIR"
      find "$BEFORE_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
    fi
    safe_rm "$BEFORE_DATA" "$RESULTS"/before-*.jsonl
    mkdir -p "$BEFORE_DIR"
    git -C "$ROOT" archive "$BEFORE_REF" | tar -x -C "$BEFORE_DIR"
    # apps/cli 是量尺而不是被测代码，用当前工作区这份；被测的提示组装在 packages/agent，那里保持 HEAD。
    safe_rm "$BEFORE_DIR/apps/cli"
    cp -R "$ROOT/apps/cli" "$BEFORE_DIR/apps/cli"
    mkdir -p "$BEFORE_DIR/tools/dev"
    cp "$ROOT/tools/dev/eval.ts" "$ROOT/tools/dev/eval-report.ts" "$ROOT/tools/dev/eval-suite.json" "$ROOT/tools/dev/process.ts" \
      "$BEFORE_DIR/tools/dev/"
    # The cleanup above keeps only the root node_modules; workspace packages lose theirs with the
    # rest of apps/ and packages/, so a missing package node_modules also means "install again".
    if [ "$REINSTALL" = 1 ] || [ ! -d "$BEFORE_DIR/node_modules" ] ||
      [ ! -d "$BEFORE_DIR/apps/desktop/node_modules" ]; then
      echo "== 在改动前那份代码里装依赖（不带密钥：依赖的安装脚本会读到环境变量）"
      ( cd "$BEFORE_DIR" && env -u PIBOT_EVAL_API_KEY -u OPENROUTER_API_KEY -u PIBOT_API_KEY pnpm install )
    fi
    run_group "$BEFORE_DIR" before "$BEFORE_DATA"
    BEFORE_CODE=$GROUP_CODE
    if [ "$TRIAL_FAILED" = 1 ]; then exit "$BEFORE_CODE"; fi
  fi
fi

echo
echo "================ 对比 ================"
( cd "$ROOT" && node tools/dev/eval.ts report "$RESULTS" ) | tee "$RESULTS/report.txt" ||
  echo "（report.txt 没写成功，不影响上面的输出）"

echo
echo "对比表已存到 $RESULTS/report.txt；把上面这段整段贴回来即可。"
if [ "$SKIP_BEFORE" = 0 ]; then
  echo "改动前那份代码留在 ${BEFORE_DIR}（里头有 node_modules，确认不需要了再 rm -rf）。"
fi

# 有任务没通过时，两组的对比表仍然输出，但整个脚本以非零结束，避免把残缺结果当成通过。
if [ "${AFTER_CODE:-0}" != 0 ] || [ "${BEFORE_CODE:-0}" != 0 ]; then
  echo "== 有任务未通过：after exit=${AFTER_CODE:-0} before exit=${BEFORE_CODE:-0}" >&2
  exit 1
fi
