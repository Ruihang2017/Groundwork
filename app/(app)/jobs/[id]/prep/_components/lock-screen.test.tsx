// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LockScreen, {
  PREP_UNLOCK_COPY,
} from '@/app/(app)/jobs/[id]/prep/_components/lock-screen';

// PRP-03 Deliverable 1 — the locked-state UI renders the exact PRD-intent copy and the
// transition button (plan §2.2, §3).
//
// R3 — the lock screen renders the client StatusTransitionButton, which calls useRouter() at
// render; without the next/navigation mock the real hook throws "invariant expected app router
// to be mounted".
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);

const JOB_ID = 'job-1';

describe('LockScreen (PRP-03 Deliverable 1)', () => {
  it('[machine] renders the exact PRD-intent unlock copy', () => {
    render(<LockScreen jobId={JOB_ID} />);
    // Assert against the exported constant so the copy and its test cannot drift.
    expect(screen.getByText(PREP_UNLOCK_COPY)).toBeTruthy();
  });

  it('[machine] renders the "I got the interview" transition button', () => {
    render(<LockScreen jobId={JOB_ID} />);
    expect(screen.getByRole('button', { name: /i got the interview/i })).toBeTruthy();
  });
});
