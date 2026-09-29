#!/usr/bin/env bash
# 全量回填（线上维护用，见 DEPLOY.md）：worker 独占行情仓，回填前要停 worker。
#
#   1. 在数据目录放维护标记 .maintenance —— 部署脚本看到它会等，不会中途重启 worker
#   2. 停 ivan-worker → 回填 A 股 → 回填港股 → doctor
#   3. 不管回填成没成功，最后都把 worker 拉起来、去掉标记（回填可断点续跑，失败了重跑本脚本即可）
#
# 用法：bash scripts/backfill-full.sh            （仓库根目录；日志写到 logs/backfill-日期.log）
#       也可以交给定时器在夜里跑，比如：
#       systemd-run --unit=ivan-backfill --on-calendar="2026-09-29 20:30:00" /bin/bash /root/ivan/ivan/scripts/backfill-full.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use 22 >/dev/null

DATA_DIR=$(grep -E '^DATA_DIR=' .env 2>/dev/null | cut -d= -f2-)
DATA_DIR=${DATA_DIR:-./data}
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$ROOT/$DATA_DIR" ;; esac
MARKER="$DATA_DIR/.maintenance"
mkdir -p logs
LOG="logs/backfill-$(date +%Y%m%d-%H%M).log"
exec >>"$LOG" 2>&1

echo "== $(date '+%F %T') 全量回填开始"
echo "全量回填 $(date '+%F %T')（scripts/backfill-full.sh，日志 $LOG）" >"$MARKER"
finish() {
  echo "== $(date '+%F %T') 收尾：拉起 worker、去掉维护标记"
  pm2 start ivan-worker >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only ivan-worker
  rm -f "$MARKER"
}
trap finish EXIT

pm2 stop ivan-worker
sleep 5
pnpm -s ivan backfill --market A && echo "== A 股回填完成"
pnpm -s ivan backfill --market HK && echo "== 港股回填完成"
pnpm -s ivan doctor
echo "== $(date '+%F %T') 全量回填结束"
