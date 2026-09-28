import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发时前端跑在 5173，接口转发到 server（默认 18905）
const serverPort = process.env.PORT ?? "18905";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${serverPort}`, changeOrigin: false } },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
