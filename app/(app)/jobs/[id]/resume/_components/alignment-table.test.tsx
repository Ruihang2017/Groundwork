// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import AlignmentTable from '@/app/(app)/jobs/[id]/resume/_components/alignment-table';
import { TAILORED_FIXTURE } from '@/app/(app)/jobs/[id]/resume/_fixtures/tailored-fixtures';

// TLR-02 acceptance item 1 — the direct proof of PRD's "库里也没有 → 显示为 gap，绝不写入简历":
// alignment-table renders NO accept/write action for ANY entry, and specifically none on a
// `missing_in_library` row.

afterEach(cleanup);

const rowByStatus = (container: HTMLElement, status: string) =>
  container.querySelector(`[data-status="${status}"]`) as HTMLElement | null;

describe('AlignmentTable (TLR-02 acceptance item 1)', () => {
  it('[machine] renders every alignment status with a real-text label', () => {
    render(<AlignmentTable alignment={TAILORED_FIXTURE.alignment} />);
    expect(screen.getByText('Present')).toBeTruthy();
    expect(screen.getByText(/missing — fixable by a rewrite/i)).toBeTruthy();
    expect(
      screen.getByText(/gap — not in your library, and never written into your resume/i),
    ).toBeTruthy();
    expect(screen.getByText('Synonym mismatch')).toBeTruthy();
  });

  it('[machine] shows the optional note when present', () => {
    render(<AlignmentTable alignment={TAILORED_FIXTURE.alignment} />);
    expect(screen.getByText(/shown as a gap, not written in/i)).toBeTruthy();
  });

  it('[machine] renders ZERO interactive controls anywhere in the table', () => {
    render(<AlignmentTable alignment={TAILORED_FIXTURE.alignment} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  });

  it('[machine] the missing_in_library row exposes NO actionable control (绝不写入简历)', () => {
    const { container } = render(<AlignmentTable alignment={TAILORED_FIXTURE.alignment} />);
    const gapRow = rowByStatus(container, 'missing_in_library');
    expect(gapRow).not.toBeNull();

    const scoped = within(gapRow!);
    expect(scoped.queryByRole('button')).toBeNull();
    expect(scoped.queryByRole('checkbox')).toBeNull();
    expect(scoped.queryByRole('link')).toBeNull();
    // And the gap's own explanatory label is present on that row.
    expect(gapRow!.textContent).toMatch(/never written into your resume/i);
  });

  it('[machine] renders one row per alignment entry', () => {
    const { container } = render(<AlignmentTable alignment={TAILORED_FIXTURE.alignment} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(
      TAILORED_FIXTURE.alignment.length,
    );
  });
});
