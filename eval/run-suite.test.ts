import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runSuite } from '@/eval/run-suite';
import type { judgeCall } from '@/eval/judge';

// EVL-02 Test-plan item 9 — runSuite dispatches each q1 kind to the right
// assertion, threads an injected mock judge through q2/q3, and (persist:false, the
// default) never touches the db.

describe('runSuite — Q1 dispatch (pure, no judge, no db)', () => {
  it('dispatches each q1 kind to the matching assertion', async () => {
    const result = await runSuite({
      op: 'cross',
      q1: [
        { kind: 'schema', rawOutput: { a: 1 }, schema: z.object({ a: z.number() }), repairAttempted: false },
        { kind: 'droppedRate', droppedCount: 15, totalCount: 100 },
        { kind: 'droppedRate', droppedCount: 14, totalCount: 100 },
      ],
    });

    expect(result.q1).toHaveLength(3);
    expect(result.q1[0]).toMatchObject({ kind: 'schema', pass: true });
    expect(result.q1[1]).toMatchObject({ kind: 'droppedRate', pass: false });
    expect(result.q1[2]).toMatchObject({ kind: 'droppedRate', pass: true });
  });

  it('runs Q2/Q3 batches through an injected mock judge', async () => {
    const judge: typeof judgeCall = async (prompt) =>
      /YES/.test(prompt) ? { verdict: 'pass', reasoning: 'p' } : { verdict: 'fail', reasoning: 'f' };

    const result = await runSuite({
      op: 'cross',
      q2: [
        { claim: 'YES a', sourceContext: 's' },
        { claim: 'no b', sourceContext: 's' },
      ],
      q3: [{ question: { projectId: 'p', question: 'YES q', trap: 't' }, candidateContext: 'c' }],
      judgeCallImpl: judge,
    });

    expect(result.q2?.passRate).toBe(0.5);
    expect(result.q3?.passRate).toBe(1);
  });
});

describe('runSuite — persistence gating', () => {
  it('never calls db.insert when persist is false/omitted', async () => {
    vi.resetModules();
    const insert = vi.fn(() => ({ values: vi.fn(async () => {}) }));
    vi.doMock('../db/index.ts', () => ({ db: { insert } }));

    const { runSuite: freshRunSuite } = await import('./run-suite.ts');
    await freshRunSuite({
      op: 'read',
      q1: [{ kind: 'droppedRate', droppedCount: 0, totalCount: 10 }],
    });

    expect(insert).not.toHaveBeenCalled();
    vi.doUnmock('../db/index.ts');
    vi.resetModules();
  });

  it('calls db.insert once for the q1 suite when persist is true', async () => {
    vi.resetModules();
    const values = vi.fn(async () => {});
    const insert = vi.fn(() => ({ values }));
    vi.doMock('../db/index.ts', () => ({ db: { insert } }));

    const { runSuite: freshRunSuite } = await import('./run-suite.ts');
    await freshRunSuite({
      op: 'read',
      q1: [{ kind: 'droppedRate', droppedCount: 0, totalCount: 10 }],
      persist: true,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ suite: 'q1', op: 'read', passRate: 1 }),
    );
    vi.doUnmock('../db/index.ts');
    vi.resetModules();
  });
});
