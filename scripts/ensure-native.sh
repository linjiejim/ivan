#!/usr/bin/env bash
# 确保 better-sqlite3 的原生模块能在这台机器上加载（部署时每次重装依赖后调用）。
#
# better-sqlite3 13 起不再下载预编译，而是把各平台的预编译直接打进 npm 包（prebuilds/*.node），
# 加载时优先用它们。自带的 linux-x64 要 glibc 2.34 / GLIBCXX 3.4.29，
# 较老的发行版（如 RHEL 8 系：glibc 2.28、GCC 8、Python 3.6）加载不了，而默认的 node-gyp 构建在有预编译时是空操作。
#
# 所以：能直接加载就什么都不做（开发机、CI、新系统都走这条）；加载不了就用 gcc-toolset-13 + Python ≥ 3.8
# 强制从源码编译，再把结果放到预编译文件的位置——先删掉原文件、断开和 pnpm store 的硬链接，不改 store 里的内容。
# pnpm 重装会把原文件恢复回来，所以部署脚本每次重装后都要再调用一次。
set -euo pipefail
cd "$(dirname "$0")/../packages/db"

probe() {
  node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); console.log('better-sqlite3 可用，SQLite ' + d.prepare('select sqlite_version() v').get().v); d.close()"
}

if probe 2>/dev/null; then exit 0; fi

echo "better-sqlite3 自带的预编译在这台机器上加载不了（glibc 太旧），从源码编译…"
if [ -f /opt/rh/gcc-toolset-13/enable ]; then
  # shellcheck disable=SC1091
  source /opt/rh/gcc-toolset-13/enable
fi
PY=$(command -v python3.12 || command -v python3.11 || command -v python3)
PKG=$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")
(cd "$PKG" && npm_config_python="$PY" npx --yes node-gyp@11 rebuild --release --force_build=1 --python="$PY" >/dev/null)
TARGET="$PKG/prebuilds/linux-x64.node"
rm -f "$TARGET"
cp "$PKG/build/Release/better_sqlite3.node" "$TARGET"
probe
