// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import EmptyMetricsBanner from '@/app/(app)/library/_components/empty-metrics-banner';
import {
  ALL_METRICS_FIXTURE,
  DRAFT_LIBRARY_FIXTURE,
  THREE_PROJECT_FIXTURE,
} from '@/app/(app)/library/_fixtures/library-fixtures';
import type { Project } from '@/lib/schemas/entities';

// Explicit cleanup — vitest globals are off in this repo, so RTL's auto-cleanup
// does not self-register (see delete-account-confirm.test.tsx).
afterEach(cleanup);

// Acceptance item 2, verbatim: "empty-metrics-banner.tsx renders when at least one
// project has metrics: [] and does NOT render when all projects have non-empty
// metrics" — PRD §5.7's 页顶红字盘点 rule.

describe('EmptyMetricsBanner (LIB-03 Deliverable 3, PRD §5.7)', () => {
  it('[machine] renders with a tally when at least one project has metrics: []', () => {
    render(<EmptyMetricsBanner projects={THREE_PROJECT_FIXTURE.projects} />);

    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('2 of 3');
    expect(banner.textContent).toContain('no metrics');
  });

  it('[machine] renders NOTHING when every project has non-empty metrics', () => {
    const { container } = render(
      <EmptyMetricsBanner projects={ALL_METRICS_FIXTURE.projects} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[machine] renders nothing for an empty library (plan §4 E4)', () => {
    // A library with no projects has nothing to tally — "0 of 0" would be noise.
    const { container } = render(<EmptyMetricsBanner projects={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('uses singular agreement for exactly one metrics-less project', () => {
    render(<EmptyMetricsBanner projects={THREE_PROJECT_FIXTURE.projects.slice(1, 3)} />);
    // slice(1,3) = pantry (no metrics) + admin-dashboard (no metrics) → 2 of 2.
    expect(screen.getByRole('alert').textContent).toContain('2 of 2 projects have');

    cleanup();
    render(<EmptyMetricsBanner projects={DRAFT_LIBRARY_FIXTURE.projects} />);
    expect(screen.getByRole('alert').textContent).toContain('1 of 2 projects has');
  });

  it('[machine] a single metric is enough to keep a project out of the tally', () => {
    const projects: Project[] = [
      { ...DRAFT_LIBRARY_FIXTURE.projects[1], metrics: ['cut p95 from 1,200ms to 380ms'] },
    ];
    const { container } = render(<EmptyMetricsBanner projects={projects} />);
    expect(container.firstChild).toBeNull();
  });

  it('is styled in the repo danger colour so the "红字" instruction is met', () => {
    render(<EmptyMetricsBanner projects={THREE_PROJECT_FIXTURE.projects} />);
    const banner = screen.getByRole('alert') as HTMLElement;
    // Presence/absence is machine-checkable; whether it READS as a red flag is
    // the ticket's [human] acceptance item.
    expect(banner.style.color).toBe('rgb(176, 0, 32)');
    expect(banner.style.fontWeight).toBe('700');
  });
});
