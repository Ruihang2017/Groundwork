// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { jobFixture } from '@/app/(app)/jobs/_fixtures/job-fixtures';

// PRP-03 acceptance item 1 + the module-level "no RESEARCH/REHEARSE" gate (plan §3).
// Mirrors app/(app)/jobs/[id]/page.test.tsx's scaffolding.
//
// Tests 1–4's assertions about the UNLOCKED PLACEHOLDER are transient: PRP-04 replaces that
// branch and will update test 4 accordingly (Feedback obligation #2). What PRP-04 must keep
// green are the LOCKED-branch tests (1–3) and the button's own behavior — those are the real
// page-level lock this ticket owns.

const { mockRequireUserId, mockGetJob, mockNotFound } = vi.hoisted(() => ({
  mockRequireUserId: vi.fn(),
  mockGetJob: vi.fn(),
  // The real notFound() throws — a non-throwing mock would let execution continue past the
  // guard and go green for the wrong reason.
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/auth/session', () => ({
  requireUserId: mockRequireUserId,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/db/queries/jobs', () => ({ getJob: mockGetJob }));
// R3 — the locked branch renders <LockScreen> → <StatusTransitionButton>, which calls
// useRouter() at render. The mock must provide BOTH notFound (this page) and useRouter (the
// child button); without useRouter the real hook throws "invariant expected app router".
vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  useRouter: () => ({ refresh: vi.fn() }),
}));

const TEST_USER_ID = 'user-abc-123';
const JOB_ID = 'job-1';

beforeEach(() => {
  mockRequireUserId.mockResolvedValue(TEST_USER_ID);
  mockGetJob.mockResolvedValue(jobFixture());
});

afterEach(cleanup);
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(id = JOB_ID) {
  const { default: JobPrepPage } = await import('@/app/(app)/jobs/[id]/prep/page');
  return render(await JobPrepPage({ params: Promise.resolve({ id }) }));
}

const lockButton = () => screen.queryByRole('button', { name: /i got the interview/i });
const unlockedHeading = () => screen.queryByRole('heading', { name: /interview prep/i });

describe('JobPrepPage — the page-level lock (PRP-03 acceptance item 1)', () => {
  it('[machine] status "screening" renders the LockScreen, not the unlocked branch', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'screening' }));
    await renderPage();

    expect(lockButton()).toBeTruthy();
    expect(unlockedHeading()).toBeNull();
  });

  it('[machine] status "applied" renders the LockScreen, not the unlocked branch', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'applied' }));
    await renderPage();

    expect(lockButton()).toBeTruthy();
    expect(unlockedHeading()).toBeNull();
  });

  it('[machine] status "closed" renders the LockScreen (branch is !== interviewing, not a screening whitelist)', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'closed' }));
    await renderPage();

    expect(lockButton()).toBeTruthy();
    expect(unlockedHeading()).toBeNull();
  });

  it('[machine] status "interviewing" renders the unlocked placeholder, not the LockScreen', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'interviewing' }));
    await renderPage();

    expect(unlockedHeading()).toBeTruthy();
    expect(lockButton()).toBeNull();
  });
});

describe('JobPrepPage — makes NO API call on any render (module-level gate)', () => {
  it('[machine] never fetches on render for any of the four statuses (locked OR unlocked)', async () => {
    const fetchMock = stubFetch();

    for (const status of ['screening', 'applied', 'closed', 'interviewing'] as const) {
      mockGetJob.mockResolvedValue(jobFixture({ status }));
      await renderPage();
    }

    // Flush any queued effects before asserting the negative (as the Fit tab test does).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('JobPrepPage — auth, scoping and failure paths', () => {
  it('[machine] reads with the SESSION userId and the awaited params.id (PRD §8.3)', async () => {
    await renderPage();
    expect(mockGetJob).toHaveBeenCalledWith(TEST_USER_ID, JOB_ID);
  });

  it('[machine] a missing job calls notFound() and renders nothing', async () => {
    mockGetJob.mockResolvedValue(null);
    const { default: JobPrepPage } = await import('@/app/(app)/jobs/[id]/prep/page');

    await expect(JobPrepPage({ params: Promise.resolve({ id: 'nope' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('[machine] a THROWING getJob (row drift) propagates rather than 404-ing', async () => {
    mockGetJob.mockRejectedValue(
      new Error('Stored job row does not match the PersistedJob schema'),
    );
    const { default: JobPrepPage } = await import('@/app/(app)/jobs/[id]/prep/page');

    await expect(JobPrepPage({ params: Promise.resolve({ id: JOB_ID }) })).rejects.toThrow(
      /PersistedJob/,
    );
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('[machine] an UnauthorizedError propagates and no job read happens', async () => {
    mockRequireUserId.mockRejectedValue(new Error('Unauthorized'));
    const { default: JobPrepPage } = await import('@/app/(app)/jobs/[id]/prep/page');

    await expect(JobPrepPage({ params: Promise.resolve({ id: JOB_ID }) })).rejects.toThrow(
      /unauthorized/i,
    );
    expect(mockGetJob).not.toHaveBeenCalled();
  });
});

describe('JobPrepPage — module contract', () => {
  it('[machine] declares force-dynamic', async () => {
    const mod = await import('@/app/(app)/jobs/[id]/prep/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('[machine] BUILD GUARD: imports cleanly with DATABASE_URL unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    vi.doUnmock('@/lib/db/queries/jobs');

    await expect(import('@/app/(app)/jobs/[id]/prep/page')).resolves.toBeDefined();
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
