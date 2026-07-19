import { describe, expect, it } from 'vitest';

import { assertQ3Specific, assertQ3SpecificBatch } from '@/eval/assertions/q3';
import type { judgeCall } from '@/eval/judge';
import type { RehearseQuestion } from '@/lib/schemas/pipeline';

// EVL-02 Test-plan item 6 (Q3) — same injected-mock-judge / batch-propagation
// discipline as q2.test.ts. PASS = specific (good) / FAIL = generic (bad).

const question = (text: string): RehearseQuestion => ({ projectId: 'p1', question: text, trap: 'trap' });

describe('assertQ3Specific', () => {
  it('propagates a pass (specific) verdict', async () => {
    const judge: typeof judgeCall = async () => ({ verdict: 'pass', reasoning: 'specific' });
    const result = await assertQ3Specific(question('why barge-in?'), 'context', { judgeCallImpl: judge });
    expect(result.pass).toBe(true);
  });

  it('propagates a fail (generic) verdict', async () => {
    const judge: typeof judgeCall = async () => ({ verdict: 'fail', reasoning: 'generic' });
    const result = await assertQ3Specific(question('greatest weakness?'), 'context', { judgeCallImpl: judge });
    expect(result.pass).toBe(false);
  });
});

describe('assertQ3SpecificBatch', () => {
  it('computes passRate 0.75 for a hand-built 3-of-4-passing batch', async () => {
    const judge: typeof judgeCall = async (prompt) =>
      /SPECIFIC_Q/.test(prompt)
        ? { verdict: 'pass', reasoning: 'p' }
        : { verdict: 'fail', reasoning: 'f' };

    const items = [
      { question: question('SPECIFIC_Q a'), candidateContext: 'c' },
      { question: question('SPECIFIC_Q b'), candidateContext: 'c' },
      { question: question('SPECIFIC_Q c'), candidateContext: 'c' },
      { question: question('generic d'), candidateContext: 'c' },
    ];

    const result = await assertQ3SpecificBatch(items, { judgeCallImpl: judge });
    expect(result.passRate).toBe(0.75);
    expect(result.results.filter((r) => r.pass)).toHaveLength(3);
  });

  it('guards an empty batch with passRate 0 (not NaN)', async () => {
    const judge: typeof judgeCall = async () => ({ verdict: 'pass', reasoning: 'p' });
    const result = await assertQ3SpecificBatch([], { judgeCallImpl: judge });
    expect(result.passRate).toBe(0);
  });
});
