/**
 * 对话的数字核对（spec §10，D69）：流式输出撤不回来，所以只标注。证据是「模型实际看到的」：
 * 每个工具的 toModelOutput 重建出来的结果（本轮全部，加上本会话之前最近 6 次），页面上下文摘要，以及用户这条消息里自己写的数。
 */
import {
  checkGrounding,
  collectEvidence,
  type EvidenceValue,
  type GroundingResult,
} from "@ivan/ai";
import { getToolOrDynamicToolName, isToolUIPart, type ToolSet, type UIMessage } from "ai";

/** 之前几轮里最多取几次工具结果当证据（spec：最近 6 次） */
export const HISTORY_TOOL_RESULTS = 6;

export interface ToolResultLike {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
}

/** 本轮的步骤（streamText 的 steps 满足它） */
export interface TurnStep {
  text: string;
  toolResults: readonly ToolResultLike[];
}

type ModelOutput = { type: string; value?: unknown };

/** 工具结果 → 模型看到的值；工具没写 toModelOutput 就是原始输出 */
async function modelView(tools: ToolSet, r: ToolResultLike): Promise<unknown> {
  const t = tools[r.toolName] as
    | {
        toModelOutput?: (o: {
          toolCallId: string;
          input: unknown;
          output: unknown;
        }) => ModelOutput | PromiseLike<ModelOutput>;
      }
    | undefined;
  if (!t?.toModelOutput) return r.output;
  const out = await t.toModelOutput({
    toolCallId: r.toolCallId,
    input: r.input,
    output: r.output,
  });
  return out.type === "json" || out.type === "text" ? out.value : null;
}

/** 历史消息里最近 n 次成功的工具结果（按出现顺序） */
export function recentToolResults(history: readonly UIMessage[], n: number): ToolResultLike[] {
  const out: ToolResultLike[] = [];
  for (const m of history) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (!isToolUIPart(p) || p.state !== "output-available") continue;
      out.push({
        toolName: getToolOrDynamicToolName(p),
        toolCallId: p.toolCallId,
        input: p.input,
        output: p.output,
      });
    }
  }
  return out.slice(-n);
}

function userText(m: UIMessage | undefined): string {
  if (!m) return "";
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export async function groundTurn(o: {
  tools: ToolSet;
  steps: readonly TurnStep[];
  /** 本轮之前的消息（不含本轮的用户消息） */
  history: readonly UIMessage[];
  /** 本轮的用户消息：用户自己写的数（「ROE 大于 15%」）复述出来不算编造 */
  userMessage?: UIMessage;
  contextSummary: string | null;
}): Promise<GroundingResult> {
  const evidence: EvidenceValue[] = [];
  const results = [
    ...recentToolResults(o.history, HISTORY_TOOL_RESULTS),
    ...o.steps.flatMap((s) => s.toolResults),
  ];
  for (const r of results) {
    try {
      evidence.push(...collectEvidence(r.toolName, await modelView(o.tools, r)));
    } catch {
      // 重建不出来（比如对象已删除）：退回原始输出
      evidence.push(...collectEvidence(r.toolName, r.output));
    }
  }
  if (o.contextSummary) evidence.push(...collectEvidence("context", o.contextSummary));
  const said = userText(o.userMessage);
  if (said) evidence.push(...collectEvidence("user", said));
  const text = o.steps.map((s) => s.text).join("\n");
  return checkGrounding(text, evidence);
}
