import { JUDGE_MODEL } from '../lib/config/models.ts';
import type { UsageOp } from '../lib/schemas/persisted.ts';

// EVL-02 Deliverable 2 — the judge-calling wrapper. Calls the Anthropic Messages
// API via plain `fetch` (PRD §8.1: "Zod 边界 + 裸 fetch 足够" — no SDK). Model is
// pinned to FND-06's JUDGE_MODEL (claude-haiku-4-5). See docs/plans/EVL-02.md §2.4.
//
// PLAIN-NODE NOTE (§2.1): `import type { UsageOp }` is fully erased by Node's
// type-stripping, so it never touches the resolver. `recordUsage` (which lives in
// lib/usage/record.ts, a file whose own `@/db/index` import cannot resolve under
// plain Node) is reached only through a LAZY dynamic import inside judgeCall, and
// only when `opts.userId` is supplied — so merely loading this module (as the
// self-check path does) never loads record.ts / db/index.ts.

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
// Cap for a pass/fail-plus-short-reasoning judge reply. Not PRD-specified — a
// Builder-adjustable constant, not load-bearing (docs/plans/EVL-02.md §2.4).
const JUDGE_MAX_TOKENS = 512;

export type JudgeVerdict = { verdict: 'pass' | 'fail'; reasoning: string };

export type JudgeCallOptions = {
  // The UsageOp being evaluated (e.g. 'cross' when judging groundedness of CROSS
  // output) — forwarded to recordUsage() so judge-call spend is itself observable.
  op?: UsageOp;
  // Omit to skip recordUsage() entirely. A CI-triggered `pnpm eval` run against
  // fixture data has no natural per-request user; a future stage-owning ticket
  // that wires a real judge call supplies its own request's userId. (Risk #1 in
  // the plan: recordUsage() prices at Sonnet rates today — inert while unused.)
  userId?: string;
  // Injection seam so tests never make a real, paid Anthropic call. Defaults to
  // the global fetch.
  fetchImpl?: typeof fetch;
};

export async function judgeCall(
  prompt: string,
  opts: JudgeCallOptions = {},
): Promise<JudgeVerdict> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const start = Date.now();

  const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  // Fail LOUD on transport/API errors. Silently returning a fake 'fail' verdict
  // would inject a false "not grounded" signal into a system whose whole point is
  // catching real hallucination (PRD §7: "证据 / 改写幻觉 P0 = 0"). Never log the
  // request headers (they carry the API key) — only status + response body.
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable response body>');
    throw new Error(
      `judgeCall: Anthropic API returned ${res.status} ${res.statusText}: ${bodyText}`,
    );
  }

  const data = await res.json();
  const durationMs = Date.now() - start;

  const text: string = data?.content?.[0]?.text ?? '';
  const match = /^\s*(pass|fail)/i.exec(text);

  const result: JudgeVerdict = match
    ? { verdict: match[1].toLowerCase() === 'pass' ? 'pass' : 'fail', reasoning: text }
    : // Fail-closed on an unparseable-but-successful reply: count it as a failure
      // rather than aborting a whole batch, and surface it for review via the
      // reasoning prefix (docs/plans/EVL-02.md §2.4).
      { verdict: 'fail', reasoning: `unparseable judge response: ${text}` };

  if (opts.userId) {
    const tokensIn: number = data?.usage?.input_tokens ?? 0;
    const tokensOut: number = data?.usage?.output_tokens ?? 0;
    // Lazy so loading this module never touches record.ts's own `@/db/index`
    // import (unresolvable under plain Node — §2.1). Reached only on this branch.
    const { recordUsage } = await import('../lib/usage/record.ts');
    await recordUsage({
      userId: opts.userId,
      op: opts.op ?? 'cross',
      tokensIn,
      tokensOut,
      searches: 0, // judge calls never use web_search
      durationMs,
    });
  }

  return result;
}
