// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import AskThemList from '@/app/(app)/jobs/[id]/prep/_components/ask-them-list';
import { REHEARSE_FIXTURE } from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';

// PRP-04 Deliverable 4 — the 3 askThem items.

afterEach(cleanup);

describe('AskThemList (PRP-04 Deliverable 4)', () => {
  it('[machine] renders each askThem item', () => {
    render(<AskThemList askThem={REHEARSE_FIXTURE.askThem} />);
    for (const item of REHEARSE_FIXTURE.askThem) {
      expect(screen.getByText(item)).toBeTruthy();
    }
  });

  it('[machine] renders a neutral line for an empty array (no crash)', () => {
    render(<AskThemList askThem={[]} />);
    expect(screen.getByText(/no questions to ask were generated/i)).toBeTruthy();
  });
});
