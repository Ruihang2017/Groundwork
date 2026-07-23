// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIT_DISCLAIMER } from '@/app/(app)/jobs/[id]/_components/composite-score-banner';
import { PARTIAL_DROPPED_NOTE } from '@/app/(app)/jobs/[id]/_components/dropped-count-header';
import { fitResponseFixture, jobFixture } from '@/app/(app)/jobs/_fixtures/job-fixtures';

// HONESTY NOTE: acceptance item 6 is a WIRING assertion — that the second server call
// fires exactly when the job has no fit, and never when it does. Nothing here says the
// resulting report is any good; that is `pnpm eval` (Q1/Q2) and the [human] dogfood
// item.

const { mockRequireUserId, mockGetJob, mockNotFound } = vi.hoisted(() => ({
  mockRequireUserId: vi.fn(),
  mockGetJob: vi.fn(),
  // The real notFound() throws — a non-throwing mock would let execution continue past
  // the guard and go green for the wrong reason.
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/auth/session', () => ({
  requireUserId: mockRequireUserId,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/db/queries/jobs', () => ({ getJob: mockGetJob }));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));

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

function stubFetch(status = 200, body: unknown = fitResponseFixture()) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage(id = JOB_ID) {
  const { default: JobFitPage } = await import('@/app/(app)/jobs/[id]/page');
  return render(await JobFitPage({ params: Promise.resolve({ id }) }));
}

describe('JobFitPage — the auto-trigger (FIT-03 acceptance item 6)', () => {
  it('[machine] a job with NO fit triggers POST /api/jobs/<id>/fit exactly once', async () => {
    mockGetJob.mockResolvedValue(jobFixture({ ledger: null, fit: null }));
    const fetchMock = stubFetch();

    await renderPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-1/fit', { method: 'POST' });
    // ...and the report from THAT response body renders (plan D4).
    await waitFor(() => expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy());
  });

  it('[machine] a job WITH a fit renders server-side and makes NO fetch call at all', async () => {
    const fetchMock = stubFetch();

    await renderPage();

    // Flush any effects that might have been queued before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    // The report is on screen without a round-trip — no paid call, no quota unit.
    expect(screen.getByText(FIT_DISCLAIMER)).toBeTruthy();
    expect(screen.getByText('58 / 100')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /hard requirements/i })).toBeTruthy();
  });

  it('[machine] a job with a fit but a NULL ledger takes the auto-runner branch, not a crash', async () => {
    // Representable in the database: nothing enforces the ledger/fit pairing, only
    // `attachLedgerAndFit`'s single statement does. Treat it as "not yet fitted".
    mockGetJob.mockResolvedValue(jobFixture({ ledger: null }));
    const fetchMock = stubFetch();

    await renderPage();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe('JobFitPage — the server-rendered path (plan D8)', () => {
  it('[machine] renders the dropped count from the LEDGER with the partial note', async () => {
    stubFetch();
    await renderPage();

    // Only layer 2's injected 'uncovered — rerun' gaps survive a page load; the raw
    // discarded entries were never persisted, and the note says so rather than letting
    // the number silently shrink.
    expect(screen.getByText('1 item was dropped')).toBeTruthy();
    expect(screen.getByText(PARTIAL_DROPPED_NOTE)).toBeTruthy();
  });

  it('[machine] renders the four sub-score cards in the fixed PRD order', async () => {
    stubFetch();
    const { container } = await renderPage();

    const headings = [...container.querySelectorAll('article h3')].map((h) => h.textContent);
    expect(headings).toEqual([
      'Technical stack match',
      'Experience depth',
      'Domain match',
      'Evidence strength',
    ]);
  });

  it('[machine] D11: no "%" anywhere in the rendered report', async () => {
    stubFetch();
    const { container } = await renderPage();
    expect(container.textContent).not.toContain('%');
  });
});

describe('JobFitPage — auth, scoping and failure paths', () => {
  it('[machine] reads with the SESSION userId and the awaited params.id (PRD §8.3)', async () => {
    stubFetch();
    await renderPage();
    expect(mockGetJob).toHaveBeenCalledWith(TEST_USER_ID, JOB_ID);
  });

  it('[machine] a missing job calls notFound() and renders nothing', async () => {
    mockGetJob.mockResolvedValue(null);
    const { default: JobFitPage } = await import('@/app/(app)/jobs/[id]/page');

    await expect(JobFitPage({ params: Promise.resolve({ id: 'nope' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('[machine] a THROWING getJob propagates rather than 404-ing', async () => {
    mockGetJob.mockRejectedValue(new Error('Stored job row does not match the PersistedJob schema'));
    const { default: JobFitPage } = await import('@/app/(app)/jobs/[id]/page');

    await expect(JobFitPage({ params: Promise.resolve({ id: JOB_ID }) })).rejects.toThrow(
      /does not match the PersistedJob schema/,
    );
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('[machine] an UnauthorizedError propagates and no job read happens', async () => {
    mockRequireUserId.mockRejectedValue(new Error('Unauthorized'));
    const { default: JobFitPage } = await import('@/app/(app)/jobs/[id]/page');

    await expect(JobFitPage({ params: Promise.resolve({ id: JOB_ID }) })).rejects.toThrow(
      /unauthorized/i,
    );
    expect(mockGetJob).not.toHaveBeenCalled();
  });
});

describe('JobFitPage — module contract', () => {
  it('[machine] declares force-dynamic', async () => {
    const mod = await import('@/app/(app)/jobs/[id]/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('[machine] BUILD GUARD: imports cleanly with DATABASE_URL unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    vi.doUnmock('@/lib/db/queries/jobs');

    await expect(import('@/app/(app)/jobs/[id]/page')).resolves.toBeDefined();
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
