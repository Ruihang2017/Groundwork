import { judgeCall } from '../judge.ts';
import type { UsageOp } from '../../lib/schemas/persisted.ts';

// EVL-02 Deliverable 4 — the Q2 (接地门) LLM-judge check. Asks whether a `claim`
// (an evidence string, a resume rewrite, or a gap's `play`) can be derived from
// its `sourceContext` (the cited library project's summary/metrics/stack, or the
// source resume text). See docs/plans/EVL-02.md §2.5.
//
// The two-positional-argument signature (claim, sourceContext) is the ticket's
// literal Deliverable-4 shape; the trailing `opts` is a plan-level extension that
// threads judgeCall's injection seam + cost-recording context without disturbing
// the first two arguments.

export type Q2JudgeOptions = {
  op?: UsageOp;
  userId?: string;
  judgeCallImpl?: typeof judgeCall;
};

// This file owns the PROMPT (per Deliverable 4); judge.ts owns only the transport
// + PASS/FAIL parsing contract. The prompt instructs the model to answer with a
// leading PASS/FAIL token (the token judge.ts parses). Prompt wording is this
// ticket's own ongoing concern once real judge runs happen (Feedback obligation #2).
function buildQ2Prompt(claim: string, sourceContext: string): string {
  return [
    'You are a strict grounding judge for a resume / interview-prep tool.',
    'Decide whether the CLAIM below can be derived ENTIRELY from the SOURCE CONTEXT.',
    'A claim is grounded only if every specific fact, number, and capability it states is',
    'supported by the source context. If it introduces any detail not present in — or not',
    'directly inferable from — the source context, it is NOT grounded.',
    '',
    'Answer with a single word on the first line: PASS if the claim is fully grounded in the',
    'source context, or FAIL if it is not. Then, on the next line, give a one-sentence reason.',
    '',
    `CLAIM:\n${claim}`,
    '',
    `SOURCE CONTEXT:\n${sourceContext}`,
  ].join('\n');
}

export async function assertQ2Grounded(
  claim: string,
  sourceContext: string,
  opts: Q2JudgeOptions = {},
): Promise<{ pass: boolean; reasoning: string }> {
  const judge = opts.judgeCallImpl ?? judgeCall;
  const { verdict, reasoning } = await judge(buildQ2Prompt(claim, sourceContext), {
    op: opts.op,
    userId: opts.userId,
  });
  return { pass: verdict === 'pass', reasoning };
}

// Batch variant computing the aggregate against PRD's "接地 ≥ 95%" threshold.
// Sequential (no Promise.all fan-out) — deliberate: avoids N uncontrolled
// concurrent Anthropic calls per batch and keeps failure attribution unambiguous
// (docs/plans/EVL-02.md Risk #3). Empty batch → passRate 0, not NaN.
export async function assertQ2GroundedBatch(
  claims: Array<{ claim: string; sourceContext: string }>,
  opts: Q2JudgeOptions = {},
): Promise<{
  passRate: number;
  results: Array<{ claim: string; pass: boolean; reasoning: string }>;
}> {
  const results: Array<{ claim: string; pass: boolean; reasoning: string }> = [];
  for (const item of claims) {
    const { pass, reasoning } = await assertQ2Grounded(item.claim, item.sourceContext, opts);
    results.push({ claim: item.claim, pass, reasoning });
  }
  const passRate =
    results.length === 0 ? 0 : results.filter((r) => r.pass).length / results.length;
  return { passRate, results };
}
