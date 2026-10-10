/**
 * `pnpm admin verify-bundle <file.json>`：离线校验决策回溯的导出文件（D71），参考实现在 @ivan/db 的 verifyBundle。
 * 只读文件，不读库；通过退出码 0，不通过或读不了退出码 1。
 */
import { readFileSync } from "node:fs";
import { BUNDLE_BREAK_TEXT, verifyBundle } from "@ivan/db";

export function verifyBundleFile(path: string): { code: 0 | 1; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { code: 1, message: `读不了 ${path}：${e instanceof Error ? e.message : String(e)}` };
  }
  const v = verifyBundle(raw);
  if (v.ok) return { code: 0, message: `校验通过：${v.checked} 条` };
  const b = v.firstBreak!;
  const why = BUNDLE_BREAK_TEXT[b.reason] ?? b.reason;
  return { code: 1, message: b.seq === null ? `校验没通过：${why}` : `第 ${b.seq} 条出错：${why}` };
}
