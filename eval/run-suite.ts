import {
  assertQ1Coverage,
  assertQ1DroppedRate,
  assertQ1NumberIntegrity,
  assertQ1Questions,
  assertQ1Schema,
} from './assertions/q1.ts';
import { assertQ2GroundedBatch } from './assertions/q2.ts';
import { assertQ3SpecificBatch } from './assertions/q3.ts';
import { writeEvalRun } from './report.ts';
import type { judgeCall } from './judge.ts';
import type { UsageOp } from '../lib/schemas/persisted.ts';
import type { JdExtract, Ledger, Rehearse, RehearseQuestion } from '../lib/schemas/pipeline.ts';
import type { ZodType } from 'zod';

// EVL-02 Deliverable 7 (extension point) — the documented `runSuite()` that a
// downstream stage-owning ticket (FIT-01/FIT-02/TLR-01/PRP-02) calls with its
// REAL stage output, without having to modify scripts/eval.mjs. See
// docs/plans/EVL-02.md §2.8.
//
// PROVISIONAL SHAPE: this tagged-union Q1 input is a best-guess design — the real
// 04-fit/05-tailor/06-prep output shapes do not exist yet. Per the ticket's
// Feedback obligation #1, a later ticket that finds this doesn't fit extends this
// file directly and records a changelog line in 02-evaluation/README.md.
//
// PLAIN-NODE NOTE (§2.1): writeEvalRun is imported at module top, but report.ts's
// own module body is import-type-only — the db-touching dynamic imports live
// inside writeEvalRun, reached only when `persist: true`. The self-check path
// always passes persist:false, so loading this module under plain Node is safe.

export type Q1Case =
  | { kind: 'schema'; rawOutput: unknown; schema: ZodType; repairAttempted: boolean }
  | { kind: 'coverage'; jd: JdExtract; ledger: Ledger }
  | { kind: 'questions'; rehearse: Rehearse }
  | {
      kind: 'numberIntegrity';
      tailorOutput: { fullDraftMd: string };
      sourcePool: { resumeMd: string; libraryMetrics: string[] };
    }
  | { kind: 'droppedRate'; droppedCount: number; totalCount: number };

export type RunSuiteInput = {
  op: UsageOp;
  q1?: Q1Case[];
  q2?: Array<{ claim: string; sourceContext: string }>;
  q3?: Array<{ question: RehearseQuestion; candidateContext: string }>;
  judgeCallImpl?: typeof judgeCall;
  userId?: string; // forwarded into every judge call's recordUsage() context
  persist?: boolean; // default false — when true, one writeEvalRun() per suite that ran
};

export type Q1Result = { kind: Q1Case['kind']; pass: boolean; detail: unknown };

export type RunSuiteResult = {
  q1: Q1Result[];
  q2?: { passRate: number; results: Array<{ claim: string; pass: boolean; reasoning: string }> };
  q3?: { passRate: number; results: Array<{ pass: boolean; reasoning: string }> };
};

function runQ1Case(testCase: Q1Case): Q1Result {
  switch (testCase.kind) {
    case 'schema': {
      const r = assertQ1Schema(testCase.rawOutput, testCase.schema, testCase.repairAttempted);
      return { kind: testCase.kind, pass: r.pass, detail: r.detail };
    }
    case 'coverage': {
      const r = assertQ1Coverage(testCase.jd, testCase.ledger);
      return { kind: testCase.kind, pass: r.pass, detail: { uncoveredCount: r.uncoveredCount } };
    }
    case 'questions': {
      const r = assertQ1Questions(testCase.rehearse);
      return { kind: testCase.kind, pass: r.pass, detail: r.detail };
    }
    case 'numberIntegrity': {
      const r = assertQ1NumberIntegrity(testCase.tailorOutput, testCase.sourcePool);
      return { kind: testCase.kind, pass: r.pass, detail: { violationCount: r.violationCount } };
    }
    case 'droppedRate': {
      const r = assertQ1DroppedRate(testCase.droppedCount, testCase.totalCount);
      return { kind: testCase.kind, pass: r.pass, detail: { rate: r.rate } };
    }
    default: {
      // Exhaustiveness guard — a compile error here if a Q1Case variant is added
      // without a matching branch above.
      const _exhaustive: never = testCase;
      throw new Error(`runSuite: unknown Q1 case kind ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function passRateOf(results: Array<{ pass: boolean }>): number {
  return results.length === 0 ? 0 : results.filter((r) => r.pass).length / results.length;
}

export async function runSuite(input: RunSuiteInput): Promise<RunSuiteResult> {
  const q1Results: Q1Result[] = (input.q1 ?? []).map(runQ1Case);
  const result: RunSuiteResult = { q1: q1Results };

  if (input.q2) {
    result.q2 = await assertQ2GroundedBatch(input.q2, {
      op: input.op,
      userId: input.userId,
      judgeCallImpl: input.judgeCallImpl,
    });
  }

  if (input.q3) {
    result.q3 = await assertQ3SpecificBatch(input.q3, {
      op: input.op,
      userId: input.userId,
      judgeCallImpl: input.judgeCallImpl,
    });
  }

  if (input.persist) {
    if (input.q1) {
      await writeEvalRun('q1', input.op, passRateOf(q1Results), { results: q1Results });
    }
    if (result.q2) {
      await writeEvalRun('q2', input.op, result.q2.passRate, { results: result.q2.results });
    }
    if (result.q3) {
      await writeEvalRun('q3', input.op, result.q3.passRate, { results: result.q3.results });
    }
  }

  return result;
}
