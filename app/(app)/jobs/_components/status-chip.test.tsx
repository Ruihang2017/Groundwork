// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import StatusChip from '@/app/(app)/jobs/_components/status-chip';
import type { JobStatus } from '@/lib/schemas/persisted';

afterEach(cleanup);

const CASES: Array<{ status: JobStatus; label: string }> = [
  { status: 'screening', label: 'Screening' },
  { status: 'applied', label: 'Applied' },
  { status: 'interviewing', label: 'Interviewing' },
  { status: 'closed', label: 'Closed' },
];

describe('StatusChip (FIT-03 Deliverable 1; PRD §5.7 状态 chip)', () => {
  it.each(CASES)('[machine] renders $status as the visible text "$label"', ({ status, label }) => {
    const { container } = render(<StatusChip status={status} />);
    expect(screen.getByText(label)).toBeTruthy();
    // The meaning is carried by TEXT, not by colour alone — the chip is readable in
    // monochrome and by a screen reader.
    expect(container.textContent?.trim()).toBe(label);
  });

  it('[machine] covers every JobStatus value with no fallthrough', () => {
    // If FND-04's enum grows, this array and the Record in the component must both be
    // updated — the Record makes it a compile error, this makes it a test failure.
    expect(CASES.map((c) => c.status).sort()).toEqual(
      ['applied', 'closed', 'interviewing', 'screening'],
    );
  });
});
