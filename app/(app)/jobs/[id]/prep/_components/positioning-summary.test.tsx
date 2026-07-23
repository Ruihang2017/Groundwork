// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import PositioningSummary from '@/app/(app)/jobs/[id]/prep/_components/positioning-summary';
import { REHEARSE_FIXTURE } from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';

// PRP-04 Deliverable 5 — the positioning paragraph; nothing when empty.

afterEach(cleanup);

describe('PositioningSummary (PRP-04 Deliverable 5)', () => {
  it('[machine] renders the positioning string', () => {
    render(<PositioningSummary positioning={REHEARSE_FIXTURE.positioning} />);
    expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy();
  });

  it('[machine] renders nothing extra for an empty positioning string', () => {
    const { container } = render(<PositioningSummary positioning="" />);
    expect(container.textContent).toBe('');
  });
});
