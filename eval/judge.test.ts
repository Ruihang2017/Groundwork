import { describe, expect, it, vi } from 'vitest';

import { judgeCall } from '@/eval/judge';

// EVL-02 Test-plan item 8 — judge.ts with its Anthropic dependency injected. No
// real API call anywhere: `fetchImpl` is a stub returning a canned
// Anthropic-shaped Response. recordUsage() is only reached when a userId is
// supplied, and is mocked in the dedicated block below.

function anthropicResponse(
  text: string,
  opts: { status?: number; usage?: { input_tokens: number; output_tokens: number } } = {},
): Response {
  const body = { content: [{ type: 'text', text }], usage: opts.usage };
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

const asFetch = (fn: (...args: unknown[]) => Promise<Response>) => fn as unknown as typeof fetch;

describe('judgeCall — verdict parsing (injected fetch, no network)', () => {
  it('parses a PASS-prefixed response as verdict:pass', async () => {
    const res = await judgeCall('prompt', {
      fetchImpl: asFetch(async () => anthropicResponse('PASS\nThe claim is fully grounded.')),
    });
    expect(res.verdict).toBe('pass');
    expect(res.reasoning).toContain('grounded');
  });

  it('parses a FAIL-prefixed response as verdict:fail', async () => {
    const res = await judgeCall('prompt', {
      fetchImpl: asFetch(async () => anthropicResponse('FAIL — not supported by the source.')),
    });
    expect(res.verdict).toBe('fail');
  });

  it('fails closed on an unparseable (neither PASS nor FAIL) response', async () => {
    const res = await judgeCall('prompt', {
      fetchImpl: asFetch(async () => anthropicResponse('I am not sure about this one.')),
    });
    expect(res.verdict).toBe('fail');
    expect(res.reasoning).toMatch(/^unparseable judge response:/);
  });

  it('throws (does not fake a fail verdict) on a non-ok API response', async () => {
    await expect(
      judgeCall('prompt', {
        fetchImpl: asFetch(async () => new Response('rate limited', { status: 429 })),
      }),
    ).rejects.toThrow(/429/);
  });

  it('does not touch recordUsage / db when userId is omitted', async () => {
    // record.ts eagerly imports @/db/index, which throws without DATABASE_URL. If
    // judgeCall wrongly imported it with no userId, this call would reject.
    await expect(
      judgeCall('prompt', {
        fetchImpl: asFetch(async () =>
          anthropicResponse('PASS ok', { usage: { input_tokens: 10, output_tokens: 5 } }),
        ),
      }),
    ).resolves.toMatchObject({ verdict: 'pass' });
  });
});

describe('judgeCall — recordUsage integration (userId supplied)', () => {
  it('records usage once with the judged op + token counts', async () => {
    vi.resetModules();
    const recordUsage = vi.fn(async () => {});
    // The dynamic import inside judgeCall is `import('../lib/usage/record.ts')`;
    // this test file sits at the same eval/ depth, so the identical relative
    // specifier resolves to the same module (docs/plans/EVL-02.md Risk #2).
    vi.doMock('../lib/usage/record.ts', () => ({ recordUsage }));

    const { judgeCall: freshJudgeCall } = await import('./judge.ts');

    await freshJudgeCall('prompt', {
      fetchImpl: asFetch(async () =>
        anthropicResponse('PASS grounded', { usage: { input_tokens: 123, output_tokens: 45 } }),
      ),
      userId: 'u1',
      op: 'tailor',
    });

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        op: 'tailor',
        tokensIn: 123,
        tokensOut: 45,
        searches: 0,
      }),
    );
    vi.doUnmock('../lib/usage/record.ts');
    vi.resetModules();
  });

  it('defaults op to "cross" and token counts to 0 when the usage block is absent', async () => {
    vi.resetModules();
    const recordUsage = vi.fn(async () => {});
    vi.doMock('../lib/usage/record.ts', () => ({ recordUsage }));

    const { judgeCall: freshJudgeCall } = await import('./judge.ts');

    await freshJudgeCall('prompt', {
      fetchImpl: asFetch(async () => anthropicResponse('PASS no usage block')),
      userId: 'u2',
    });

    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u2', op: 'cross', tokensIn: 0, tokensOut: 0 }),
    );
    vi.doUnmock('../lib/usage/record.ts');
    vi.resetModules();
  });
});
