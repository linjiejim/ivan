import { describe, expect, it } from "vitest";
import { attributeDrift, changeCause, type DriftCur, type DriftPrev } from "./drift.ts";
import type { ReplayCheck } from "./replay.ts";

const drift: ReplayCheck = {
  compared: 10,
  navDrift: 2,
  benchDrift: 0,
  firstDrift: "2026-09-29",
  maxNavDiff: 0.01,
};
const clean: ReplayCheck = {
  ...drift,
  navDrift: 0,
  benchDrift: 0,
  firstDrift: null,
  maxNavDiff: 0,
};
const prev: DriftPrev = {
  engineVersion: "1.2.0",
  execHash: "e1",
  prefixHash: "p1",
  hashVersion: 1,
};
const cur: DriftCur = { engineVersion: "1.2.0", execHash: "e1", prefixHash: "p1", hashVersion: 1 };

describe("attributeDrift（D57）", () => {
  const cases: Array<[string, DriftPrev, DriftCur, ReplayCheck, string]> = [
    ["没有漂移", prev, { ...cur, prefixHash: "p2", engineVersion: "9" }, clean, "none"],
    ["上一晚没存指纹", {}, cur, drift, "unrecorded"],
    ["上一晚没有前缀指纹", { ...prev, prefixHash: null }, cur, drift, "unrecorded"],
    [
      "指纹口径版本不同",
      { ...prev, hashVersion: 0 },
      { ...cur, prefixHash: "p2" },
      drift,
      "unrecorded",
    ],
    [
      "引擎不同",
      { ...prev, engineVersion: "1.1.0" },
      { ...cur, prefixHash: "p2" },
      drift,
      "engine",
    ],
    ["成交假设不同", prev, { ...cur, execHash: "e2", prefixHash: "p2" }, drift, "exec"],
    ["前缀指纹不同", prev, { ...cur, prefixHash: "p2" }, drift, "data"],
    ["都一样却漂移", prev, cur, drift, "unexplained"],
  ];
  for (const [name, p, c, r, want] of cases) {
    it(name, () => expect(attributeDrift(p, c, r).cause).toBe(want));
  }

  it("文案", () => {
    expect(attributeDrift(prev, { ...cur, prefixHash: "p2" }, drift).text).toBe(
      "数据被修订过（2026-09-29 起）",
    );
    expect(attributeDrift({ ...prev, engineVersion: "1.1.0" }, cur, drift).text).toBe(
      "引擎从 1.1.0 升级到 1.2.0",
    );
    expect(attributeDrift(prev, { ...cur, execHash: "e2" }, drift).text).toBe("成交假设改过");
    expect(attributeDrift(prev, cur, drift).text).toBe("原因不明（已记录，属于程序问题）");
    expect(attributeDrift({}, cur, drift).text).toMatch(/分不清/);
  });
});

describe("changeCause 判断顺序", () => {
  const p = { engineVersion: "1.2.0", hashVersion: 1, execHash: "e", data: ["a", 1] };
  it("没记录先于一切", () => {
    expect(changeCause({ ...p, engineVersion: null }, { ...p, engineVersion: "2" })).toBe(
      "unrecorded",
    );
    expect(changeCause({ ...p, data: null }, p)).toBe("unrecorded");
  });
  it("引擎先于指纹口径、成交假设与数据", () => {
    expect(
      changeCause(p, { engineVersion: "2", hashVersion: 2, execHash: "x", data: ["b", 2] }),
    ).toBe("engine");
  });
  it("指纹口径先于成交假设与数据", () => {
    expect(changeCause(p, { ...p, hashVersion: 2, execHash: "x", data: ["b"] })).toBe("unrecorded");
  });
  it("成交假设先于数据", () => {
    expect(changeCause(p, { ...p, execHash: "x", data: ["b"] })).toBe("exec");
  });
  it("数据按位比较；都一样是 none", () => {
    expect(changeCause(p, { ...p, data: ["a", 2] })).toBe("data");
    expect(changeCause(p, { ...p, data: ["a"] })).toBe("data");
    expect(changeCause(p, { ...p })).toBe("none");
  });
});
