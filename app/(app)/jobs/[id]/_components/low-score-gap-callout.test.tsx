// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import LowScoreGapCallout, {
  UNCOVERED_GAP_COPY,
} from '@/app/(app)/jobs/[id]/_components/low-score-gap-callout';
import {
  JD_FIXTURE,
  NORMAL_GAP_FIXTURE,
  UNCOVERED_GAP_FIXTURE,
  fitFixture,
} from '@/app/(app)/jobs/_fixtures/job-fixtures';

// HONESTY NOTE: gating and copy only. Whether the two gaps chosen are the RIGHT two
// to close is a scoring-quality question (`pnpm eval`), not something a render can
// answer.

afterEach(cleanup);

describe('LowScoreGapCallout (FIT-03 acceptance item 4; PRD §5.2 低分页面)', () => {
  it('[machine] renders for tier Stretch', () => {
    render(<LowScoreGapCallout fit={fitFixture({ tier: 'Stretch' })} jd={JD_FIXTURE} />);
    expect(screen.getByRole('heading', { name: /close these two gaps first/i })).toBeTruthy();
  });

  it('[machine] renders for tier "Long shot" (note the space — E7)', () => {
    render(<LowScoreGapCallout fit={fitFixture({ tier: 'Long shot' })} jd={JD_FIXTURE} />);
    expect(screen.getByRole('heading', { name: /close these two gaps first/i })).toBeTruthy();
  });

  it('[machine] renders NOTHING for tier Strong', () => {
    const { container } = render(
      <LowScoreGapCallout fit={fitFixture({ tier: 'Strong' })} jd={JD_FIXTURE} />,
    );
    expect(container.textContent).toBe('');
  });

  it('[machine] renders NOTHING for tier Competitive', () => {
    const { container } = render(
      <LowScoreGapCallout fit={fitFixture({ tier: 'Competitive' })} jd={JD_FIXTURE} />,
    );
    expect(container.textContent).toBe('');
  });

  it('[machine] D13: shows AT MOST two gaps even though topGaps holds three', () => {
    const fit = fitFixture({ tier: 'Stretch' });
    expect(fit.topGaps).toHaveLength(3);

    render(<LowScoreGapCallout fit={fit} jd={JD_FIXTURE} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // The third gap's probe must not appear.
    expect(screen.queryByText(/gRPC service boundary/i)).toBeNull();
  });

  it('[machine] a normal gap renders BOTH probe and play, keyed to the requirement text', () => {
    render(
      <LowScoreGapCallout
        fit={fitFixture({ tier: 'Stretch', topGaps: [NORMAL_GAP_FIXTURE] })}
        jd={JD_FIXTURE}
      />,
    );
    expect(screen.getByText(/Based in Berlin or willing to relocate/)).toBeTruthy();
    expect(screen.getByText(/They will probe: .*Berlin office/)).toBeTruthy();
    expect(screen.getByText(/Your bridge: .*already planning the move/)).toBeTruthy();
  });

  it('[machine] D13: exactly ONE gap uses the singular heading', () => {
    render(
      <LowScoreGapCallout
        fit={fitFixture({ tier: 'Stretch', topGaps: [NORMAL_GAP_FIXTURE] })}
        jd={JD_FIXTURE}
      />,
    );
    expect(screen.getByRole('heading', { name: /close this gap first/i })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('[machine] D13/E5: an INJECTED gap renders the substitute line and NO empty "Your bridge:"', () => {
    // FND-07's layer-2 injections carry probe === UNCOVERED_MARKER and play: '' by
    // design, and they ARE eligible for topGaps. Rendering "Your bridge:" followed by
    // nothing is the trap this closes.
    expect(UNCOVERED_GAP_FIXTURE.play).toBe('');

    const { container } = render(
      <LowScoreGapCallout
        fit={fitFixture({ tier: 'Long shot', topGaps: [UNCOVERED_GAP_FIXTURE] })}
        jd={JD_FIXTURE}
      />,
    );
    expect(screen.getByText(UNCOVERED_GAP_COPY)).toBeTruthy();
    expect(container.textContent).not.toContain('Your bridge:');
    expect(container.textContent).not.toContain('They will probe:');
    // The requirement itself is still named.
    expect(screen.getByText(/Terraform \/ infrastructure as code/)).toBeTruthy();
  });

  it('[machine] D13: topGaps: [] renders NOTHING even on a low tier', () => {
    // A heading promising gaps with no gaps under it is worse than silence. This is
    // reachable: E3's zero-requirement JD produces exactly it.
    const { container } = render(
      <LowScoreGapCallout
        fit={fitFixture({ tier: 'Long shot', compositeScore: 0, topGaps: [] })}
        jd={JD_FIXTURE}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('[machine] E4: a gap whose requirementId is absent from the JD renders the RAW ID', () => {
    render(
      <LowScoreGapCallout
        fit={fitFixture({
          tier: 'Stretch',
          topGaps: [{ requirementId: 'ghost-id', probe: 'Probe?', play: 'Play.' }],
        })}
        jd={JD_FIXTURE}
      />,
    );
    expect(screen.getByText('ghost-id')).toBeTruthy();
  });
});
