// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LIBRARY_FIXTURE,
  REHEARSE_FIXTURE,
  briefFixture,
  rehearseResponseFixture,
  researchResponseFixture,
} from '@/app/(app)/jobs/[id]/prep/_fixtures/brief-fixtures';
import { jobFixture } from '@/app/(app)/jobs/_fixtures/job-fixtures';

// PRP-03 acceptance item 1 + PRP-04 Deliverable 7 (plan §3). Mirrors
// app/(app)/jobs/[id]/page.test.tsx's scaffolding.
//
// The LOCKED-branch tests (1–3) + the auth/scoping/guard tests are PRP-03 regressions and are
// unchanged (PRP-03 Feedback obligation #2: PRP-04 preserves the locked-state behaviour). The
// UNLOCKED-branch assertions changed from PRP-03's transient placeholder ("Interview prep" /
// "Your interview brief will appear here") to real brief content: the generator's progress UI
// when no Brief exists, and <BriefView> when one does (acceptance item 5 pins that a reload of
// an existing Brief triggers NO regeneration fetch).

const { mockRequireUserId, mockGetJob, mockGetBrief, mockGetLibrary, mockNotFound } = vi.hoisted(
  () => ({
    mockRequireUserId: vi.fn(),
    mockGetJob: vi.fn(),
    mockGetBrief: vi.fn(),
    mockGetLibrary: vi.fn(),
    // The real notFound() throws — a non-throwing mock would let execution continue past the
    // guard and go green for the wrong reason.
    mockNotFound: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
  }),
);

vi.mock('@/lib/auth/session', () => ({
  requireUserId: mockRequireUserId,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/db/queries/jobs', () => ({ getJob: mockGetJob }));
vi.mock('@/lib/db/queries/briefs', () => ({ getBrief: mockGetBrief }));
vi.mock('@/lib/db/queries/library', () => ({ getLibrary: mockGetLibrary }));
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
  // Defaults: no Brief yet, a non-empty library. The locked-branch tests never reach these
  // reads (the lock check returns first), so the default status 'screening' keeps them stable.
  mockGetBrief.mockResolvedValue(null);
  mockGetLibrary.mockResolvedValue(LIBRARY_FIXTURE);
});

afterEach(cleanup);
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Reply = { status: number; body?: unknown };

/** Queues replies in call order; extra calls reuse the last. Defaults to a single 200 {}. */
function stubFetch(...replies: Reply[]) {
  const queue = replies.length > 0 ? replies : [{ status: 200, body: {} }];
  let call = 0;
  const fetchMock = vi.fn().mockImplementation(async () => {
    const reply = queue[Math.min(call, queue.length - 1)];
    call += 1;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? {},
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(id = JOB_ID) {
  const { default: JobPrepPage } = await import('@/app/(app)/jobs/[id]/prep/page');
  return render(await JobPrepPage({ params: Promise.resolve({ id }) }));
}

const lockButton = () => screen.queryByRole('button', { name: /i got the interview/i });
const briefHeading = () => screen.queryByRole('heading', { name: /interview brief/i });

describe('JobPrepPage — the page-level lock (PRP-03 acceptance item 1)', () => {
  it('[machine] status "screening" renders the LockScreen, not the unlocked branch', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'screening' }));
    await renderPage();

    expect(lockButton()).toBeTruthy();
    expect(briefHeading()).toBeNull();
  });

  it('[machine] status "applied" renders the LockScreen, not the unlocked branch', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'applied' }));
    await renderPage();

    expect(lockButton()).toBeTruthy();
    expect(briefHeading()).toBeNull();
  });

  it('[machine] status "closed" renders the LockScreen (branch is !== interviewing, not a screening whitelist)', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'closed' }));
    await renderPage();

    expect(lockButton()).toBeTruthy();
    expect(briefHeading()).toBeNull();
  });
});

describe('JobPrepPage — the unlocked branch (PRP-04 Deliverable 7)', () => {
  it('[machine] interviewing + NO persisted Brief renders the generator progress UI (RESEARCH first)', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'interviewing' }));
    mockGetBrief.mockResolvedValue(null);
    stubFetch(
      { status: 200, body: researchResponseFixture() },
      { status: 200, body: rehearseResponseFixture() },
    );
    await renderPage();

    // The generator mounts in the 'researching' phase (proven end-to-end in
    // brief-generator.test.tsx; here we only assert it mounted).
    expect(screen.getByRole('status').textContent).toMatch(/researching the company/i);
    expect(lockButton()).toBeNull();
    // Let the auto-fired sequence settle so no state update leaks past the test.
    await waitFor(() => expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy());
  });

  it('[machine] interviewing + a persisted Brief renders BriefView, not the LockScreen', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'interviewing' }));
    mockGetBrief.mockResolvedValue(briefFixture());
    await renderPage();

    expect(briefHeading()).toBeTruthy();
    expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy();
    expect(lockButton()).toBeNull();
  });

  it('[machine] acceptance item 5: a SECOND render of an already-generated Brief triggers NO regeneration fetch', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ status: 'interviewing' }));
    mockGetBrief.mockResolvedValue(briefFixture());
    const fetchMock = stubFetch();
    await renderPage();

    // Flush any queued effects before asserting the negative (as the Fit tab test does).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(REHEARSE_FIXTURE.positioning)).toBeTruthy();
  });
});

describe('JobPrepPage — makes NO API call on the locked branch or the reload path', () => {
  it('[machine] never fetches on render for the three locked statuses or interviewing-with-Brief', async () => {
    const fetchMock = stubFetch();

    for (const status of ['screening', 'applied', 'closed'] as const) {
      mockGetJob.mockResolvedValue(jobFixture({ status }));
      await renderPage();
    }
    // The reload path (a Brief already exists) is a pure server render — also zero fetch.
    mockGetJob.mockResolvedValue(jobFixture({ status: 'interviewing' }));
    mockGetBrief.mockResolvedValue(briefFixture());
    await renderPage();

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
    vi.doUnmock('@/lib/db/queries/briefs');
    vi.doUnmock('@/lib/db/queries/library');

    await expect(import('@/app/(app)/jobs/[id]/prep/page')).resolves.toBeDefined();
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
