/**
 * 对话状态行（D45）：回复进行到哪一步了。模型思考、工具执行都没有可见输出，不提示的话看起来像卡住了。
 */
import type { UIMessage } from "ai";

/** 工具在跑时，状态行里说「正在…」 */
export const TOOL_ACTIVITY: Record<string, string> = {
  list_factors: "查看可用因子",
  list_strategies: "查看你的策略",
  get_strategy: "读取策略",
  propose_strategy: "写策略草稿",
  run_backtest: "回测",
  get_run: "读取回测结果",
  list_runs: "查看回测记录",
  query_run: "下钻回测",
  compare_runs: "对比回测",
  run_sensitivity: "做参数扫描",
  screen_today: "按策略选股",
  screen_rules: "按条件选股",
  lookup_security: "查个股",
  get_security_evidence: "查个股证据",
  propose_tracking: "准备上线跟踪",
  get_tracking: "读取跟踪",
  get_overview: "查看看板",
  propose_stop_tracking: "准备停止跟踪",
  get_plan: "查计划依据",
};

/**
 * 回复进行到哪一步了（D45）：模型思考、工具执行都没有可见输出，不提示的话看起来像卡住了。
 * 只有正文正在一个字一个字出来时才返回 null。
 */
export function activityOf(messages: UIMessage[], status: string): string | null {
  if (status === "submitted") return "思考中";
  if (status !== "streaming") return null;
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return "思考中";
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const p = last.parts[i] as {
      type: string;
      state?: string;
      preliminary?: boolean;
      text?: string;
    };
    if (p.type === "step-start") continue;
    if (p.type.startsWith("tool-")) {
      const running =
        p.state === "input-streaming" || p.state === "input-available" || p.preliminary === true;
      return running ? `正在${TOOL_ACTIVITY[p.type.slice(5)] ?? "调用工具"}` : "整理结果中";
    }
    if (p.type === "text") return p.state === "streaming" && p.text ? null : "思考中";
    if (p.type === "reasoning") return "思考中";
  }
  return "思考中";
}
