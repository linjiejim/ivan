import { describe, expect, it, vi } from "vitest";
import { createVersionCheck, liveCommit, VERSION_CHECK_GAP_MS } from "./new-version.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

/** 手动拨的钟 + 记下每次读了什么 */
function setup(responses: Array<unknown | Error>, current = A) {
  let t = 1_000_000;
  const onFound = vi.fn();
  const load = vi.fn(async () => {
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return r;
  });
  const watch = createVersionCheck({ current, load, onFound, now: () => t });
  return { watch, load, onFound, tick: (ms: number) => (t += ms) };
}

describe("liveCommit", () => {
  it("只认非空字符串", () => {
    expect(liveCommit({ commit: B })).toBe(B);
    expect(liveCommit({ commit: "" })).toBeNull();
    expect(liveCommit({ commit: null })).toBeNull();
    expect(liveCommit({ commit: 42 })).toBeNull();
    expect(liveCommit({})).toBeNull();
    expect(liveCommit(null)).toBeNull();
    expect(liveCommit("<!doctype html>")).toBeNull();
  });
});

describe("createVersionCheck", () => {
  it("同一个提交不提示；换了提交提示一次，之后不再查", async () => {
    const { watch, load, onFound, tick } = setup([{ commit: A }, { commit: B }, { commit: B }]);
    await watch.check();
    expect(onFound).not.toHaveBeenCalled();
    tick(VERSION_CHECK_GAP_MS);
    await watch.check();
    expect(onFound).toHaveBeenCalledTimes(1);
    tick(10 * VERSION_CHECK_GAP_MS);
    await watch.check();
    expect(load).toHaveBeenCalledTimes(2);
    expect(onFound).toHaveBeenCalledTimes(1);
  });

  it("一分钟内只真查一次", async () => {
    const { watch, load, tick } = setup([{ commit: A }, { commit: A }]);
    await watch.check();
    tick(VERSION_CHECK_GAP_MS - 1);
    await watch.check();
    expect(load).toHaveBeenCalledTimes(1);
    tick(1);
    await watch.check();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("读失败、拿不到提交号都不说话，下一次照常查", async () => {
    const { watch, load, onFound, tick } = setup([
      new Error("offline"),
      new SyntaxError("Unexpected token '<'"),
      { commit: null },
      null,
      { commit: B },
    ]);
    for (let i = 0; i < 4; i++) {
      await watch.check();
      tick(VERSION_CHECK_GAP_MS);
    }
    expect(onFound).not.toHaveBeenCalled();
    await watch.check();
    expect(load).toHaveBeenCalledTimes(5);
    expect(onFound).toHaveBeenCalledTimes(1);
  });

  it("停了以后，还在路上的那次回来也不提示", async () => {
    let resolve!: (v: unknown) => void;
    const onFound = vi.fn();
    const watch = createVersionCheck({
      current: A,
      load: () => new Promise((r) => (resolve = r)),
      onFound,
    });
    const pending = watch.check();
    watch.stop();
    resolve({ commit: B });
    await pending;
    expect(onFound).not.toHaveBeenCalled();
  });
});
