#!/usr/bin/env bash
# 行情仓升级（线上维护用，见 DEPLOY.md「行情仓升级」）：要改大表的表结构升级（第 3 版在约 2500 万行日线上补 src、ver 列；
# 第 5 版在约 1600 万行因子表上加 7 个事件因子列）
# worker 启动时不做（部署健康检查只等 24 秒、pm2 有内存上限，D76），这时 worker 进维护状态，由本脚本停掉 worker 后执行。
#
#   0. 先等 worker 手上的任务做完（最多一小时，等不到就不升级）
#   1. 在数据目录放维护标记 .maintenance —— 部署脚本看到它会等，不会中途重启 worker
#   2. 停 ivan-worker → 把行情仓拷一份 market.duckdb.pre-migrate-日期（MIGRATE_NO_BACKUP=1 跳过；空间不够就不升级）
#      → pnpm ivan migrate（DuckDB 内存上限默认 512MB，可用 MIGRATE_MEMORY_LIMIT 改）→ doctor
#   3. 不管成没成功，最后都把 worker 拉起来、去掉标记（升级语句可重跑，失败了重跑本脚本即可）
#
# 用法：bash scripts/migrate.sh            （仓库根目录；日志写到 logs/migrate-日期.log）
#       MIGRATE_MEMORY_LIMIT=768MB bash scripts/migrate.sh
#       bash scripts/migrate.sh --down 4   （换回 R4 或更早的代码之前，包括 R1 之前的首版 R0：删掉第 5 版的 7 个事件因子列、版本号写回 4；
#                                            要在当前代码的目录里、git reset 之前跑，见 DEPLOY.md）
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
LOG="logs/migrate-$(date +%Y%m%d-%H%M).log"
exec >>"$LOG" 2>&1

echo "== $(date '+%F %T') 行情仓升级开始"
# 先等 worker 手上的任务（夜间更新、回测）做完，最多一小时；还忙就这次不升级，什么都不动
if ! WAIT_MINUTES=60 node --no-warnings scripts/deploy-wait-idle.mjs; then
  echo "== worker 一直在忙，这次不升级"
  exit 1
fi
echo "行情仓升级 $(date '+%F %T')（scripts/migrate.sh，日志 $LOG）" >"$MARKER"
finish() {
  echo "== $(date '+%F %T') 收尾：拉起 worker、去掉维护标记"
  pm2 start ivan-worker >/dev/null 2>&1 || pm2 start ecosystem.config.cjs --only ivan-worker
  rm -f "$MARKER"
}
trap finish EXIT

pm2 stop ivan-worker
sleep 5
# 升级是在大表上原地 ALTER，没有整体事务：先留一份副本（worker 已停，文件是静止的）
if [ "${MIGRATE_NO_BACKUP:-}" != "1" ] && [ -f "$DATA_DIR/market.duckdb" ]; then
  BACKUP="$DATA_DIR/market.duckdb.pre-migrate-$(date +%Y%m%d-%H%M)"
  NEED_KB=$(du -k "$DATA_DIR/market.duckdb" | cut -f1)
  FREE_KB=$(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}')
  if [ "$FREE_KB" -lt $((NEED_KB + 1048576)) ]; then
    echo "== 磁盘剩余 ${FREE_KB}KB，不够留一份行情仓副本（要 ${NEED_KB}KB + 1GB），这次不升级；腾出空间或设 MIGRATE_NO_BACKUP=1"
    exit 1
  fi
  echo "== 备份行情仓到 $BACKUP"
  if ! cp "$DATA_DIR/market.duckdb" "$BACKUP"; then
    echo "== 备份失败，这次不升级"
    exit 1
  fi
  [ -f "$DATA_DIR/market.duckdb.wal" ] && cp "$DATA_DIR/market.duckdb.wal" "$BACKUP.wal"
fi
# 命令行的环境变量优先于 .env（process.loadEnvFile 不覆盖已有的变量）
# --down 4 原样传给 pnpm ivan migrate
if DUCKDB_MEMORY_LIMIT="${MIGRATE_MEMORY_LIMIT:-512MB}" pnpm -s ivan migrate "$@"; then
  echo "== 升级完成"
else
  echo "== 升级失败（worker 拉起后仍是维护状态），看上面的报错后重跑本脚本"
fi
pnpm -s ivan doctor
echo "== $(date '+%F %T') 行情仓升级结束"
