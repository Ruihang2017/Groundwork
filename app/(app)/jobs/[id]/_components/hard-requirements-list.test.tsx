// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import HardRequirementsList from '@/app/(app)/jobs/[id]/_components/hard-requirements-list';
import { fitFixture } from '@/app/(app)/jobs/_fixtures/job-fixtures';

// HONESTY NOTE: these tests prove rendering and copy, not that the hard-requirement
// classifications are correct — those come from a model and are `pnpm eval`'s
// concern. Tone and legibility are the ticket's [human] acceptance item.

afterEach(cleanup);

describe('HardRequirementsList (FIT-03 Deliverable 5; PRD §5.2 "置顶展示")', () => {
  it('[machine] renders one row per item, each with its label', () => {
    const items = fitFixture().hardRequirements;
    render(<HardRequirementsList items={items} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(items.length);
    for (const item of items) {
      expect(screen.getByText(new RegExp(item.label.replace(/[()]/g, '\\$&'), 'i'))).toBeTruthy();
    }
  });

  it('[machine] D12: each status is carried as TEXT (Pass / Fail / Unknown), not colour alone', () => {
    render(<HardRequirementsList items={fitFixture().hardRequirements} />);
    // The fixture has exactly one of each status.
    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText('Fail')).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('[machine] D12: an EMPTY array renders the explicit line, not nothing', () => {
    // An empty hardRequirements array is a NORMAL outcome (FIT-02 emits an entry only
    // for kinds the posting actually states). A silently absent PRD-mandated section
    // reads as a rendering bug.
    const { container } = render(<HardRequirementsList items={[]} />);
    expect(screen.getByText(/no hard requirements we could check/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /hard requirements/i })).toBeTruthy();
    expect(container.textContent).not.toBe('');
  });

  it('[machine] renders labels as TEXT — no HTML injection from model output', () => {
    render(
      <HardRequirementsList
        items={[{ label: '<img src=x onerror="alert(1)">', status: 'unknown' }]}
      />,
    );
    expect(screen.getByText(/<img src=x onerror/)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('[machine] survives duplicate labels (free model text, no stable id)', () => {
    render(
      <HardRequirementsList
        items={[
          { label: 'Visa', status: 'pass' },
          { label: 'Visa', status: 'fail' },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
