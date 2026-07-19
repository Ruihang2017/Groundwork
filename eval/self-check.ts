import { z } from 'zod';

import {
  assertQ1Coverage,
  assertQ1DroppedRate,
  assertQ1NumberIntegrity,
  assertQ1Questions,
  assertQ1Schema,
} from './assertions/q1.ts';
import { runSuite } from './run-suite.ts';
import type { judgeCall } from './judge.ts';
import type { JdExtract, Ledger, Rehearse } from '../lib/schemas/pipeline.ts';

// EVL-02 Deliverable 7 (self-check mode) — the runnable machinery behind
// `pnpm eval` while no real stage routes exist yet. Constructs, per assertion,
// one hand-built PASSING mock and one deliberately-VIOLATING mock, runs the
// assertion, and confirms each result matches its expected pass/fail outcome —
// proving the harness's own logic is correct. Sets a non-zero exit code only on a
// genuine harness-logic bug (an expectation violated). See docs/plans/EVL-02.md
// §2.10.
//
// This file is spawned by scripts/eval.mjs under `node --experimental-strip-types`.
// It NEVER makes a real Anthropic call (Q2/Q3 run through an injected mock judge)
// and NEVER touches the DB (runSuite is always called with persist:false) — so it
// is safe to run with no ANTHROPIC_API_KEY and no DATABASE_URL configured. The
// hard-pinned numeric boundaries below are the ticket's own literal numbers (the
// 0.15/0.1499 dropped-rate boundary, the 1-of-2 batch pass rate), not
// Builder-invented ones.

type SelfCheckCase = { label: string; expectPass: boolean; run: () => boolean };

// --- Hand-built mock stage outputs ------------------------------------------

const mockSchema = z.object({ id: z.string(), score: z.number() });

const jdTwoRequirements: JdExtract = {
  requirements: [
    { id: 'r1', text: 'TypeScript', weight: 3, category: 'technical' },
    { id: 'r2', text: '5 years experience', weight: 2, category: 'experience' },
  ],
  atsKeywords: ['typescript'],
  subtext: [],
};

const ledgerEveryRequirementCoveredOnce: Ledger = {
  bindings: [{ requirementId: 'r1', projectId: 'p1', strength: 'strong', evidence: 'Built X in TS' }],
  gaps: [{ requirementId: 'r2', probe: 'How many years?', play: 'Emphasize depth over tenure' }],
};

const ledgerRequirementUncovered: Ledger = {
  // r2 appears in NEITHER bindings nor gaps → uncovered.
  bindings: [{ requirementId: 'r1', projectId: 'p1', strength: 'strong', evidence: 'Built X in TS' }],
  gaps: [],
};

const rehearseAllTrapsPresent: Rehearse = {
  questions: Array.from({ length: 5 }, (_, i) => ({
    projectId: 'p1',
    question: `Question ${i}`,
    trap: `Trap ${i}`,
  })),
  askThem: ['a', 'b', 'c'],
  positioning: 'A realtime-systems engineer.',
};

const rehearseOneEmptyTrap: Rehearse = {
  questions: Array.from({ length: 5 }, (_, i) => ({
    projectId: 'p1',
    question: `Question ${i}`,
    trap: i === 2 ? '' : `Trap ${i}`,
  })),
  askThem: ['a', 'b', 'c'],
  positioning: 'A realtime-systems engineer.',
};

const numberSourcePool = {
  resumeMd: 'Served 12,000 users and cut latency 40%.',
  libraryMetrics: ['12,000 users'],
};

const cases: SelfCheckCase[] = [
  {
    label: 'Q1 schema — valid output',
    expectPass: true,
    run: () => assertQ1Schema({ id: 'x', score: 1 }, mockSchema, false).pass,
  },
  {
    label: 'Q1 schema — invalid output (even after 1 repair)',
    expectPass: false,
    run: () => assertQ1Schema({ id: 'x' }, mockSchema, true).pass,
  },
  {
    label: 'Q1 coverage — every requirement covered exactly once',
    expectPass: true,
    run: () => assertQ1Coverage(jdTwoRequirements, ledgerEveryRequirementCoveredOnce).pass,
  },
  {
    label: 'Q1 coverage — a requirement covered by neither bindings nor gaps',
    expectPass: false,
    run: () => assertQ1Coverage(jdTwoRequirements, ledgerRequirementUncovered).pass,
  },
  {
    label: 'Q1 questions — 5 questions, all traps non-empty',
    expectPass: true,
    run: () => assertQ1Questions(rehearseAllTrapsPresent).pass,
  },
  {
    label: 'Q1 questions — an empty trap',
    expectPass: false,
    run: () => assertQ1Questions(rehearseOneEmptyTrap).pass,
  },
  {
    label: 'Q1 numberIntegrity — every number grounded in the source pool',
    expectPass: true,
    run: () => assertQ1NumberIntegrity({ fullDraftMd: 'Served 12,000 users.' }, numberSourcePool).pass,
  },
  {
    label: 'Q1 numberIntegrity — a fabricated number',
    expectPass: false,
    run: () => assertQ1NumberIntegrity({ fullDraftMd: 'Served 999,999 users.' }, numberSourcePool).pass,
  },
  {
    label: 'Q1 droppedRate — passing (14.99%)',
    expectPass: true,
    run: () => assertQ1DroppedRate(14.99, 100).pass,
  },
  {
    label: 'Q1 droppedRate — violating (15% exactly, strict <)',
    expectPass: false,
    run: () => assertQ1DroppedRate(15, 100).pass,
  },
];

// Deterministic offline judge — keyed on a sentinel embedded in the judge prompt
// (which itself embeds the claim / candidate context). No network call.
const mockJudgeCall: typeof judgeCall = async (prompt) =>
  /GROUNDED_OK|SPECIFIC_OK/.test(prompt)
    ? { verdict: 'pass', reasoning: 'mock: supported' }
    : { verdict: 'fail', reasoning: 'mock: unsupported' };

async function main(): Promise<void> {
  let failures = 0;

  for (const testCase of cases) {
    const pass = testCase.run();
    const ok = pass === testCase.expectPass;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${testCase.label} (got pass=${pass}, expected pass=${testCase.expectPass})`,
    );
    if (!ok) failures += 1;
  }

  // Q2/Q3 batch pass-rate propagation through runSuite with the injected mock
  // judge: 1 of 2 passing in each batch → passRate 0.5.
  const suite = await runSuite({
    op: 'cross',
    q2: [
      { claim: 'grounded claim', sourceContext: 'GROUNDED_OK: the source states exactly this' },
      { claim: 'fabricated claim', sourceContext: 'the source says nothing of the kind' },
    ],
    q3: [
      {
        question: { projectId: 'p1', question: 'Why barge-in?', trap: 'And the echo-cancellation cost?' },
        candidateContext: 'SPECIFIC_OK: requires this project\'s realtime details',
      },
      {
        question: { projectId: 'p1', question: 'What is your greatest weakness?', trap: 'Elaborate.' },
        candidateContext: 'any candidate could answer this',
      },
    ],
    judgeCallImpl: mockJudgeCall,
    persist: false, // never touches the DB in self-check mode (§2.8)
  });

  const q2Ok = suite.q2?.passRate === 0.5;
  const q3Ok = suite.q3?.passRate === 0.5;
  console.log(
    `${q2Ok ? 'OK  ' : 'FAIL'} Q2 batch pass-rate propagation (got ${suite.q2?.passRate}, expected 0.5)`,
  );
  console.log(
    `${q3Ok ? 'OK  ' : 'FAIL'} Q3 batch pass-rate propagation (got ${suite.q3?.passRate}, expected 0.5)`,
  );
  if (!q2Ok) failures += 1;
  if (!q3Ok) failures += 1;

  const total = cases.length + 2;
  console.log('');
  console.log(
    `eval self-check: ${failures === 0 ? 'PASS' : 'FAIL'} (${total} checks, ${failures} failing)`,
  );
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('eval self-check crashed:', err);
  process.exitCode = 1;
});
