import { describe, expect, it } from 'vitest';

import { assertQ2Grounded, assertQ2GroundedBatch } from '@/eval/assertions/q2';
import type { judgeCall } from '@/eval/judge';

// EVL-02 Test-plan item 6 (Q2) — judgeCall injected as a deterministic mock (no
// real API spend); the mocked verdict must propagate through to the batch
// pass-rate. Batch example is the ticket's own literal 3-of-4 → 0.75.

const passJudge: typeof judgeCall = async () => ({ verdict: 'pass', reasoning: 'grounded' });
const failJudge: typeof judgeCall = async () => ({ verdict: 'fail', reasoning: 'not grounded' });

describe('assertQ2Grounded', () => {
  it('propagates a pass verdict from the injected judge', async () => {
    const result = await assertQ2Grounded('claim', 'context', { judgeCallImpl: passJudge });
    expect(result.pass).toBe(true);
    expect(result.reasoning).toBe('grounded');
  });

  it('propagates a fail verdict', async () => {
    const result = await assertQ2Grounded('claim', 'context', { judgeCallImpl: failJudge });
    expect(result.pass).toBe(false);
  });
});

describe('assertQ2GroundedBatch', () => {
  it('computes passRate 0.75 for a hand-built 3-of-4-passing batch', async () => {
    // Judge keyed on a sentinel embedded in the claim (which the prompt embeds).
    const judge: typeof judgeCall = async (prompt) =>
      /OK_CLAIM/.test(prompt)
        ? { verdict: 'pass', reasoning: 'p' }
        : { verdict: 'fail', reasoning: 'f' };

    const batch = [
      { claim: 'OK_CLAIM a', sourceContext: 's' },
      { claim: 'OK_CLAIM b', sourceContext: 's' },
      { claim: 'OK_CLAIM c', sourceContext: 's' },
      { claim: 'unsupported d', sourceContext: 's' },
    ];

    const result = await assertQ2GroundedBatch(batch, { judgeCallImpl: judge });
    expect(result.passRate).toBe(0.75);
    expect(result.results.filter((r) => r.pass)).toHaveLength(3);
    expect(result.results).toHaveLength(4);
  });

  it('guards an empty batch with passRate 0 (not NaN)', async () => {
    const result = await assertQ2GroundedBatch([], { judgeCallImpl: passJudge });
    expect(result.passRate).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});
