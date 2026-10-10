/**
 * 简报按版次只追加（D70）：每次生成都加一版 brief_editions，并记一条账本 brief 指向它；briefs 仍是看板读的当前版。
 * 内容指纹 = sha256Canonical({date, facts, content, model, grounding})，账本校验时按库里存的这一版重算。
 */
import { sha256Canonical } from "@ivan/core/node";
import { and, eq, sql } from "drizzle-orm";
import type { AppDbHandle } from "./index.ts";
import { appendLedger } from "./ledger.ts";
import { briefEditions, briefs } from "./schema.ts";
import { newId } from "./util.ts";

export interface BriefEditionContent {
  date: string;
  facts: Record<string, unknown>;
  content: string | null;
  model: string | null;
  grounding: Record<string, unknown> | null;
}

/** 存进库之后再读出来是同一份 JSON：先过一遍 JSON，免得 undefined、NaN 让写入时与校验时的指纹不同 */
function normalized(c: BriefEditionContent): BriefEditionContent {
  return JSON.parse(
    JSON.stringify({
      date: c.date,
      facts: c.facts,
      content: c.content,
      model: c.model,
      grounding: c.grounding,
    }),
  ) as BriefEditionContent;
}

export function briefEditionHash(c: BriefEditionContent): string {
  const n = normalized(c);
  return sha256Canonical({
    date: n.date,
    facts: n.facts,
    content: n.content ?? null,
    model: n.model ?? null,
    grounding: n.grounding ?? null,
  });
}

/** 按库里存的这一版重算内容指纹；行不存在返回 null */
export function briefEditionHashOf(h: AppDbHandle, id: string): string | null {
  const r = h.db.select().from(briefEditions).where(eq(briefEditions.id, id)).get();
  if (!r) return null;
  return briefEditionHash({
    date: r.date,
    facts: r.facts,
    content: r.content,
    model: r.model,
    grounding: r.grounding ?? null,
  });
}

/**
 * 写一版简报：版次 = 这个用户这一天已有的最大版次 + 1；同一个 IMMEDIATE 事务里插版次、更新当前版、记账本。
 */
export function writeBriefEdition(
  h: AppDbHandle,
  userId: string,
  c: BriefEditionContent,
): { id: string; edition: number; ledgerSeq: number } {
  const n = normalized(c);
  const payloadHash = briefEditionHash(n);
  return h.sqlite
    .transaction(() => {
      const max =
        h.db
          .select({ m: sql<number | null>`max(${briefEditions.edition})` })
          .from(briefEditions)
          .where(and(eq(briefEditions.userId, userId), eq(briefEditions.date, n.date)))
          .get()?.m ?? 0;
      const edition = max + 1;
      const id = newId("be_");
      const at = Date.now();
      h.db
        .insert(briefEditions)
        .values({
          id,
          userId,
          date: n.date,
          edition,
          facts: n.facts,
          content: n.content,
          model: n.model,
          grounding: n.grounding,
          createdAt: at,
        })
        .run();
      h.db
        .insert(briefs)
        .values({
          id: newId("b_"),
          userId,
          date: n.date,
          facts: n.facts,
          content: n.content,
          model: n.model,
          grounding: n.grounding,
          createdAt: at,
        })
        .onConflictDoUpdate({
          target: [briefs.userId, briefs.date],
          set: {
            facts: n.facts,
            content: n.content,
            model: n.model,
            grounding: n.grounding,
            createdAt: at,
          },
        })
        .run();
      const le = appendLedger(h, {
        userId,
        kind: "brief",
        subjectType: "user",
        subjectId: userId,
        asOf: n.date,
        payloadTable: "brief_editions",
        payloadId: id,
        payloadHash,
      });
      return { id, edition, ledgerSeq: le.seq };
    })
    .immediate();
}
