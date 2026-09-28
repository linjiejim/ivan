import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { activityOf } from "./activity.ts";

const user: UIMessage = { id: "u", role: "user", parts: [{ type: "text", text: "回测一下" }] };
const ai = (parts: unknown[]): UIMessage => ({
  id: "a",
  role: "assistant",
  parts: parts as UIMessage["parts"],
});

describe("对话状态行", () => {
  it("刚发出去、还没有任何输出：思考中", () => {
    expect(activityOf([user], "submitted")).toBe("思考中");
    expect(activityOf([user], "streaming")).toBe("思考中");
    expect(activityOf([user, ai([{ type: "step-start" }])], "streaming")).toBe("思考中");
  });

  it("模型在推理（没有正文）：思考中", () => {
    expect(
      activityOf([user, ai([{ type: "reasoning", text: "…", state: "streaming" }])], "streaming"),
    ).toBe("思考中");
  });

  it("工具在跑（含回测这种先吐进度的）：正在…", () => {
    const running = ai([{ type: "tool-run_backtest", state: "input-available", input: {} }]);
    expect(activityOf([user, running], "streaming")).toBe("正在回测");
    const prelim = ai([
      { type: "tool-run_sensitivity", state: "output-available", preliminary: true, output: {} },
    ]);
    expect(activityOf([user, prelim], "streaming")).toBe("正在做参数扫描");
    const unknown = ai([{ type: "tool-something_new", state: "input-streaming" }]);
    expect(activityOf([user, unknown], "streaming")).toBe("正在调用工具");
  });

  it("工具跑完、模型还没开口：整理结果中", () => {
    const done = ai([
      { type: "tool-get_overview", state: "output-available", output: {} },
      { type: "step-start" },
    ]);
    expect(activityOf([user, done], "streaming")).toBe("整理结果中");
  });

  it("正文正在出来时不打扰；结束后没有状态", () => {
    const talking = ai([{ type: "text", text: "两个跟踪", state: "streaming" }]);
    expect(activityOf([user, talking], "streaming")).toBeNull();
    expect(activityOf([user, talking], "ready")).toBeNull();
  });
});
