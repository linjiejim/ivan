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
      // 回测与 ETL 的内存尖峰只影响自己；按小内存机器（约 1.2 GB 空闲）给个上限，内存预算见 DEPLOY.md
      max_memory_restart: "900M",
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
