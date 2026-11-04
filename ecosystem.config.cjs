// pm2 进程定义（演示站与自部署通用）：两个进程，server 对外，worker 只监听 127.0.0.1。
// 用法：pnpm install && pnpm build && pm2 start ecosystem.config.cjs && pm2 save
// 用 node --import tsx 而不是 tsx 命令：tsx 命令会再起一个 node 子进程，pm2 只量得到外层（约 4 MB），
// max_memory_restart 就永远不会触发。回测线程也是这样加载 TypeScript 的（sim-pool.ts）。
const common = {
  interpreter: "node",
  interpreter_args: "--import tsx",
  cwd: __dirname,
  env: { NODE_ENV: "production" },
  merge_logs: true,
  max_restarts: 10,
  restart_delay: 3000,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "ivan-worker",
      script: "apps/worker/src/main.ts",
      error_file: "logs/worker.error.log",
      out_file: "logs/worker.out.log",
      // pm2 每 30 秒才量一次：这条线只兜慢慢涨上去的内存，尖峰靠 DuckDB、价格面板、回测线程各自的上限（DEPLOY.md「worker 内存预算」）
      max_memory_restart: "900M",
      // worker 收到信号后几百毫秒内退出（打断查询、终止回测线程、CHECKPOINT 后关库），8 秒兜底强退（apps/worker/src/shutdown.ts）
      kill_timeout: 10000,
    },
    {
      ...common,
      name: "ivan-server",
      script: "apps/server/src/main.ts",
      error_file: "logs/server.error.log",
      out_file: "logs/server.out.log",
      max_memory_restart: "400M",
    },
  ],
};
