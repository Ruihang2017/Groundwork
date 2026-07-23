// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import CompositeScoreBanner, {
  FIT_DISCLAIMER,
  PARTIAL_COMPOSITE_NOTE,
} from '@/app/(app)/jobs/[id]/_components/composite-score-banner';
import {
  NOT_ASSESSED_SUB_SCORE,
  emptyFitFixture,
  fitFixture,
} from '@/app/(app)/jobs/_fixtures/job-fixtures';
import type { FitTier } from '@/lib/schemas/pipeline';

// HONESTY NOTE: this file proves the disclaimer is unskippable and the format is not
// a percentage. It proves nothing about whether the score is a good score.

afterEach(cleanup);

const TIERS: FitTier[] = ['Strong', 'Competitive', 'Stretch', 'Long shot'];

describe('CompositeScoreBanner (FIT-03 acceptance item 3; PRD §5.2 "诚实标注")', () => {
  // PRD's "不得暗示统计意义" is UNCONDITIONAL — not a low-score caveat. A Strong
  // report at 100 is precisely where a reader hears "you'll get this job".
  it.each(
    TIERS.flatMap((tier) => [0, 100].map((compositeScore) => ({ tier, compositeScore }))),
  )(
    '[machine] always renders the disclaimer — tier $tier, score $compositeScore',
    ({ tier, compositeScore }) => {
      render(<CompositeScoreBanner fit={fitFixture({ tier, compositeScore })} />);
      expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy();
    },
  );

  it('[machine] D11: renders "58 / 100" and NO "%" character anywhere', () => {
    const { container } = render(<CompositeScoreBanner fit={fitFixture()} />);
    expect(screen.getByText('58 / 100')).toBeTruthy();
    // The cheapest mechanical enforcement of PRD's "不得暗示统计意义": a percent sign
    // next to a number is read as a probability by every reader.
    expect(container.textContent).not.toContain('%');
  });

  it('[machine] renders the tier and the scorer-supplied advice', () => {
    const fit = fitFixture();
    render(<CompositeScoreBanner fit={fit} />);
    expect(screen.getByText('Competitive')).toBeTruthy();
    expect(screen.getByText(fit.advice)).toBeTruthy();
  });

  it('[machine] D7: adds the "average of the assessed sub-scores" line ONLY when a bucket was excluded', () => {
    const allAssessed = render(<CompositeScoreBanner fit={fitFixture()} />);
    expect(allAssessed.queryByText(PARTIAL_COMPOSITE_NOTE)).toBeNull();
    cleanup();

    const withGap = fitFixture({
      subScores: { ...fitFixture().subScores, domain: { ...NOT_ASSESSED_SUB_SCORE } },
    });
    render(<CompositeScoreBanner fit={withGap} />);
    expect(screen.getByText(PARTIAL_COMPOSITE_NOTE)).toBeTruthy();
    // ...and the disclaimer is still there, unaffected by the extra line.
    expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy();
  });

  it('[machine] E3: the zero-requirement JD case renders 0 / 100 + Long shot without crashing', () => {
    // Legal per FND-03 (`requirements` has only `.max(11)`); FIT-02 short-circuits it
    // to an all-empty report. All four buckets are unassessed, so D7's line shows.
    const { container } = render(<CompositeScoreBanner fit={emptyFitFixture()} />);
    expect(screen.getByText('0 / 100')).toBeTruthy();
    expect(screen.getByText('Long shot')).toBeTruthy();
    expect(screen.getByText(PARTIAL_COMPOSITE_NOTE)).toBeTruthy();
    expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy();
    expect(container.textContent).not.toContain('%');
  });

  it('[machine] E7: the tier with a space renders verbatim as "Long shot"', () => {
    render(<CompositeScoreBanner fit={fitFixture({ tier: 'Long shot', compositeScore: 12 })} />);
    expect(screen.getByText('Long shot')).toBeTruthy();
  });
});
