// EVL-02 barrel smoke test — closes the Reviewer's finding #3: the Goal's literal
// consumption path
//
//   import { assertQ1Schema, ..., assertQ2Grounded, assertQ3Specific } from '@/eval'
//
// was previously validated only by tsc's re-export name checking, never executed
// at runtime. If the bare directory specifier `@/eval` ever fails to resolve to
// eval/index.ts under a consumer's resolver — or the barrel re-exports a name that
// is type-only / undefined at runtime — that would otherwise surface first in a
// downstream ticket (FIT-01/FIT-02/TLR-01/PRP-02) instead of here. This test
// imports the exact Goal path from '@/eval' and RUNS one representative export
// from each assertion family so a broken barrel fails in this module.

import { describe, expect, it } from 'vitest';

import {
  assertQ1Schema,
  assertQ1Coverage,
  assertQ1Questions,
  assertQ1NumberIntegrity,
  assertQ1DroppedRate,
  assertQ2Grounded,
  assertQ3Specific,
} from '@/eval';
import { z } from 'zod';

import type { judgeCall } from '@/eval';
import type { JdExtract, Ledger, Rehearse, RehearseQuestion } from '@/lib/schemas/pipeline';

describe('@/eval barrel (Goal consumption path)', () => {
  it('re-exports every named function as a runtime binding, not a type-only name', () => {
    // A barrel that accidentally re-exported one of these via `export type` (or a
    // specifier that failed to resolve) would leave the binding `undefined` here.
    for (const fn of [
      assertQ1Schema,
      assertQ1Coverage,
      assertQ1Questions,
      assertQ1NumberIntegrity,
      assertQ1DroppedRate,
      assertQ2Grounded,
      assertQ3Specific,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });

  it('runs a deterministic Q1 export imported from @/eval', () => {
    // Prove the imported binding is the real function, not a stub: exercise the
    // strict-`<` dropped-rate boundary through the barrel import.
    expect(assertQ1DroppedRate(14.99, 100).pass).toBe(true);
    expect(assertQ1DroppedRate(15, 100).pass).toBe(false);

    const schema = z.object({ id: z.string() });
    expect(assertQ1Schema({ id: 'x' }, schema, false).pass).toBe(true);
    expect(assertQ1Schema({}, schema, true).pass).toBe(false);

    const jd: JdExtract = {
      requirements: [{ id: 'r1', text: 'TypeScript', weight: 3, category: 'technical' }],
      atsKeywords: ['typescript'],
      subtext: [],
    };
    const ledger: Ledger = {
      bindings: [{ requirementId: 'r1', projectId: 'p1', strength: 'strong', evidence: 'Built X' }],
      gaps: [],
    };
    expect(assertQ1Coverage(jd, ledger).pass).toBe(true);

    const rehearse: Rehearse = {
      questions: Array.from({ length: 5 }, (_, i) => ({
        projectId: 'p1',
        question: `Q${i}`,
        trap: `T${i}`,
      })),
      askThem: ['a'],
      positioning: 'An engineer.',
    };
    expect(assertQ1Questions(rehearse).pass).toBe(true);

    expect(
      assertQ1NumberIntegrity(
        { fullDraftMd: 'Served 12,000 users.' },
        { resumeMd: 'Served 12,000 users.', libraryMetrics: ['12,000 users'] },
      ).pass,
    ).toBe(true);
  });

  it('runs the async judge exports imported from @/eval with an injected mock', async () => {
    // No network: inject a deterministic mock judge so the Q2/Q3 exports are proven
    // to be the real runtime bindings while making zero real Anthropic calls.
    const mockJudgeCall: typeof judgeCall = async (prompt) =>
      /GROUNDED_OK|SPECIFIC_OK/.test(prompt)
        ? { verdict: 'pass', reasoning: 'mock: supported' }
        : { verdict: 'fail', reasoning: 'mock: unsupported' };

    const q2 = await assertQ2Grounded('a claim', 'GROUNDED_OK: source says exactly this', {
      judgeCallImpl: mockJudgeCall,
    });
    expect(q2.pass).toBe(true);

    const question: RehearseQuestion = {
      projectId: 'p1',
      question: 'Why barge-in?',
      trap: 'And the echo-cancellation cost?',
    };
    const q3 = await assertQ3Specific(question, 'any candidate could answer this', {
      judgeCallImpl: mockJudgeCall,
    });
    expect(q3.pass).toBe(false);
  });
});
