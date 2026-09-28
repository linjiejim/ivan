// pm2 进程定义（jim-server 与自部署通用）：两个进程，server 对外，worker 只监听 127.0.0.1。
// 用法：pnpm install && pnpm build && pm2 start ecosystem.config.cjs && pm2 save
const common = {
  interpreter: "./node_modules/.bin/tsx",
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
      // 回测与 ETL 的内存尖峰只影响自己；jim-server 只有约 1.2 GB 空闲，给个上限
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
