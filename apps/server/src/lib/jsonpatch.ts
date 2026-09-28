/**
 * 最小 JSON Patch（RFC 6902 的 add / replace / remove）。LLM 改策略时可以只给补丁。
 */
export interface PatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

function parsePath(path: string): string[] {
  if (path === "" || path === "/") return [];
  if (!path.startsWith("/")) throw new Error(`补丁路径要以 / 开头：${path}`);
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function applyPatch<T>(doc: T, ops: readonly PatchOp[]): T {
  const root = structuredClone(doc) as unknown;
  for (const op of ops) {
    const keys = parsePath(op.path);
    if (!keys.length) throw new Error("不能替换整个文档，请直接给完整策略");
    let parent = root as Record<string, unknown> | unknown[];
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      let next = Array.isArray(parent) ? parent[Number(k)] : parent[k];
      if (next === undefined || next === null) {
        if (op.op === "remove") throw new Error(`路径不存在：${op.path}`);
        next = /^\d+$/.test(keys[i + 1]!) || keys[i + 1] === "-" ? [] : {};
        if (Array.isArray(parent)) parent[Number(k)] = next;
        else parent[k] = next;
      }
      parent = next as Record<string, unknown> | unknown[];
    }
    const last = keys.at(-1)!;
    if (Array.isArray(parent)) {
      const idx = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length)
        throw new Error(`数组下标不对：${op.path}`);
      if (op.op === "add") parent.splice(idx, 0, op.value);
      else if (op.op === "replace") parent[idx] = op.value;
      else parent.splice(idx, 1);
    } else if (op.op === "remove") {
      delete parent[last];
    } else {
      parent[last] = op.value;
    }
  }
  return root as T;
}
