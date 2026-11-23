import { execFileSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// 开发时前端跑在 5173，接口转发到 server（默认 18905）
const serverPort = process.env.PORT ?? "18905";

/**
 * 这次构建来自哪个提交。服务器上是 git 克隆、部署时现场构建，没有 GITHUB_SHA，所以直接问 git。
 * 取不到（没装 git、不是克隆下来的代码）就是 null：照常构建，只是不带新版本提示。
 */
function buildCommit(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

const commit = buildCommit();

/**
 * 构建产物里放一份 /version.json（{ "commit": … }），和包里的 __APP_COMMIT__ 是同一个值。
 * 已经打开的页面拿它和自己比，不一样就提示刷新（components/new-version.tsx）；server 托管时不缓存它。
 */
function versionFile(): Plugin {
  return {
    name: "ivan-version-file",
    apply: "build",
    buildStart() {
      if (!commit) this.warn("取不到提交号（没有 git？），这次构建不带新版本提示");
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ commit })}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), versionFile()],
  define: { __APP_COMMIT__: JSON.stringify(commit) },
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${serverPort}`, changeOrigin: false } },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
