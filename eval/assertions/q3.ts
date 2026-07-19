import { judgeCall } from '../judge.ts';
import type { UsageOp } from '../../lib/schemas/persisted.ts';
import type { RehearseQuestion } from '../../lib/schemas/pipeline.ts';

// EVL-02 Deliverable 5 — the Q3 (特异门) LLM-judge check. Per PRD §6's exact
// framing: "预测问题能否问任何一个随机候选人？能 → fail". A question is GOOD
// (PASS) when it is specific to this candidate's project; BAD (FAIL) when it is
// generic enough to ask any random candidate. See docs/plans/EVL-02.md §2.6.

export type Q3JudgeOptions = {
  op?: UsageOp;
  userId?: string;
  judgeCallImpl?: typeof judgeCall;
};

// PASS = specific (good) / FAIL = generic (bad) — the mapping mirrors PRD's
// "能问任何候选人 → fail". Same contract/wording ownership split as q2.ts.
function buildQ3Prompt(question: RehearseQuestion, candidateContext: string): string {
  return [
    'You are a specificity judge for interview-rehearsal questions.',
    'A GOOD rehearsal question is SPECIFIC: it can only be meaningfully asked of THIS candidate',
    "because it depends on the concrete details of their own project. A BAD question is GENERIC:",
    'it could be asked of any random candidate with a similar title, without knowing anything',
    'about this specific project.',
    '',
    'Answer with a single word on the first line: PASS if the question is specific to this',
    "candidate's project, or FAIL if it is generic enough to ask any random candidate. Then, on",
    'the next line, give a one-sentence reason.',
    '',
    `QUESTION:\n${question.question}`,
    `FOLLOW-UP TRAP:\n${question.trap}`,
    '',
    `CANDIDATE / PROJECT CONTEXT:\n${candidateContext}`,
  ].join('\n');
}

export async function assertQ3Specific(
  question: RehearseQuestion,
  candidateContext: string,
  opts: Q3JudgeOptions = {},
): Promise<{ pass: boolean; reasoning: string }> {
  const judge = opts.judgeCallImpl ?? judgeCall;
  const { verdict, reasoning } = await judge(buildQ3Prompt(question, candidateContext), {
    op: opts.op,
    userId: opts.userId,
  });
  return { pass: verdict === 'pass', reasoning };
}

// Batch variant computing the aggregate against PRD's "≥ 90% 特异" threshold.
// Sequential for the same reasons as q2.ts's batch (Risk #3). Empty → passRate 0.
export async function assertQ3SpecificBatch(
  items: Array<{ question: RehearseQuestion; candidateContext: string }>,
  opts: Q3JudgeOptions = {},
): Promise<{ passRate: number; results: Array<{ pass: boolean; reasoning: string }> }> {
  const results: Array<{ pass: boolean; reasoning: string }> = [];
  for (const item of items) {
    const { pass, reasoning } = await assertQ3Specific(item.question, item.candidateContext, opts);
    results.push({ pass, reasoning });
  }
  const passRate =
    results.length === 0 ? 0 : results.filter((r) => r.pass).length / results.length;
  return { passRate, results };
}
