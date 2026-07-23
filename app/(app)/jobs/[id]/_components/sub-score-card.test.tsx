// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import SubScoreCard from '@/app/(app)/jobs/[id]/_components/sub-score-card';
import {
  JD_FIXTURE,
  LEDGER_FIXTURE,
  NOT_ASSESSED_SUB_SCORE,
  fitFixture,
} from '@/app/(app)/jobs/_fixtures/job-fixtures';

// HONESTY NOTE: this file proves the drill-down renders the evidence it was given and
// that a not-assessed bucket never shows a 0. It proves nothing about whether the
// evidence is good — that is `pnpm eval`'s Q2.

afterEach(cleanup);

const technical = fitFixture().subScores.technical;

describe('SubScoreCard (FIT-03 Deliverable 5; PRD §5.2 "分数可下钻到证据")', () => {
  it('[machine] D11: renders "60 / 100" and no "%" anywhere', () => {
    const { container } = render(
      <SubScoreCard label="Technical stack match" sub={technical} jd={JD_FIXTURE} ledger={LEDGER_FIXTURE} />,
    );
    expect(screen.getByText('60 / 100')).toBeTruthy();
    expect(container.textContent).not.toContain('%');
  });

  it('[machine] D7: a NOT-ASSESSED bucket renders the words, never the number 0', () => {
    // Showing "Domain match 0 / 100" for a category the posting never asked about
    // reports a failure that did not happen — FIT-02's D6 exists to prevent exactly
    // this misreading.
    const { container } = render(
      <SubScoreCard
        label="Domain match"
        sub={NOT_ASSESSED_SUB_SCORE}
        jd={JD_FIXTURE}
        ledger={LEDGER_FIXTURE}
      />,
    );
    expect(screen.getByText('Not assessed')).toBeTruthy();
    expect(screen.getByText(/no requirement in this category/i)).toBeTruthy();
    expect(container.textContent).not.toContain('0 / 100');
    expect(container.textContent).not.toContain('%');
  });

  it('[machine] drill-down shows each binding evidence, projectId and strength', () => {
    render(
      <SubScoreCard label="Technical stack match" sub={technical} jd={JD_FIXTURE} ledger={LEDGER_FIXTURE} />,
    );

    // r1 carries TWO bindings — both must show, not just the strongest.
    expect(screen.getByText(/Strong · voice-agent — Ran a 40-node EKS cluster/)).toBeTruthy();
    expect(
      screen.getByText(/Partial · billing-migration — Operated the staging cluster/),
    ).toBeTruthy();
    // Its requirement text heads the row.
    expect(screen.getByText('Production Kubernetes at scale')).toBeTruthy();
  });

  it('[machine] drill-down shows each gap probe and play', () => {
    render(
      <SubScoreCard label="Technical stack match" sub={technical} jd={JD_FIXTURE} ledger={LEDGER_FIXTURE} />,
    );
    expect(screen.getByText(/They will probe: .*gRPC service boundary/)).toBeTruthy();
    expect(screen.getByText(/Your bridge: .*REST API versioning/)).toBeTruthy();
  });

  it('[machine] E5: an injected gap (play: "") renders no empty "Your bridge:" line', () => {
    // r5 is the layer-2 injection in LEDGER_FIXTURE and is one of `technical`'s gaps.
    const { container } = render(
      <SubScoreCard label="Technical stack match" sub={technical} jd={JD_FIXTURE} ledger={LEDGER_FIXTURE} />,
    );
    // Exactly one "Your bridge:" — r6's. r5's is suppressed.
    expect(container.textContent?.match(/Your bridge:/g) ?? []).toHaveLength(1);
  });

  it('[machine] the summary states the counts so the user can decide to open it', () => {
    render(
      <SubScoreCard label="Technical stack match" sub={technical} jd={JD_FIXTURE} ledger={LEDGER_FIXTURE} />,
    );
    expect(screen.getByText(/1 supported · 2 gaps/)).toBeTruthy();
  });

  it('[machine] E4: an unknown requirementId renders the RAW ID and does not throw', () => {
    const { container } = render(
      <SubScoreCard
        label="Technical stack match"
        sub={{ score: 40, bindings: ['ghost-id'], gaps: [] }}
        jd={JD_FIXTURE}
        ledger={LEDGER_FIXTURE}
      />,
    );
    expect(screen.getByText('ghost-id')).toBeTruthy();
    // The row exists rather than being silently dropped (PRD "宁可暴露不完整").
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('[machine] a bucket with gaps but no bindings still shows its real score (§5 Q2)', () => {
    render(
      <SubScoreCard
        label="Evidence strength"
        sub={{ score: 0, bindings: [], gaps: ['r4', 'r6'] }}
        jd={JD_FIXTURE}
        ledger={LEDGER_FIXTURE}
      />,
    );
    expect(screen.getByText('0 / 100')).toBeTruthy();
    expect(screen.queryByText('Not assessed')).toBeNull();
  });
});
