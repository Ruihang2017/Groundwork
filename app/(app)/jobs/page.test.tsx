// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JOB_LIST_FIXTURE, jobFixture } from '@/app/(app)/jobs/_fixtures/job-fixtures';

// The three server-side modules the page reaches. `vi.hoisted` keeps STABLE mock
// references across `vi.resetModules()` — the pattern app/(app)/library/page.test.tsx
// and app/api/parse/route.test.ts both use for the same reason.
const { mockRequireUserId, mockListJobs, mockHasLibrary } = vi.hoisted(() => ({
  mockRequireUserId: vi.fn(),
  mockListJobs: vi.fn(),
  mockHasLibrary: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireUserId: mockRequireUserId,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/db/queries/jobs', () => ({ listJobs: mockListJobs }));
vi.mock('@/lib/db/queries/library', () => ({ hasLibrary: mockHasLibrary }));

const TEST_USER_ID = 'user-abc-123';

beforeEach(() => {
  mockRequireUserId.mockResolvedValue(TEST_USER_ID);
  mockListJobs.mockResolvedValue([]);
  mockHasLibrary.mockResolvedValue(true);
});

afterEach(cleanup);
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function renderPage() {
  const { default: JobsPage } = await import('@/app/(app)/jobs/page');
  return render(await JobsPage());
}

describe('JobsPage (FIT-03 Deliverable 3; PRD §5.7 Jobs 列表)', () => {
  it('[machine] scopes BOTH reads to the session userId (PRD §8.3)', async () => {
    await renderPage();
    expect(mockListJobs).toHaveBeenCalledWith(TEST_USER_ID);
    expect(mockHasLibrary).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it('[machine] renders one <article> per job and all four status chips from the fixture', async () => {
    mockListJobs.mockResolvedValue(JOB_LIST_FIXTURE);
    await renderPage();

    expect(screen.getAllByRole('article')).toHaveLength(JOB_LIST_FIXTURE.length);
    // Derived from the fixture (one row per JobStatus), not hardcoded.
    for (const label of ['Screening', 'Applied', 'Interviewing', 'Closed']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('[machine] each row links to /jobs/<id> with company and role in the accessible name', async () => {
    mockListJobs.mockResolvedValue(JOB_LIST_FIXTURE);
    await renderPage();

    const link = screen.getByRole('link', {
      name: /northwind payments — staff platform engineer/i,
    });
    expect(link.getAttribute('href')).toBe('/jobs/job-screening');
  });

  it('[machine] renders newest-first in the order listJobs returned (no re-sorting here)', async () => {
    mockListJobs.mockResolvedValue(JOB_LIST_FIXTURE);
    const { container } = await renderPage();

    const companies = [...container.querySelectorAll('article')].map(
      (a) => a.textContent?.split(' —')[0],
    );
    expect(companies).toEqual(JOB_LIST_FIXTURE.map((j) => j.company));
  });

  it('[machine] hasLibrary=true renders the paste form', async () => {
    await renderPage();
    expect(screen.getByLabelText(/job description/i)).toBeTruthy();
  });

  it('[machine] hasLibrary=false renders the /library CTA and NO usable form (PRD §5.7)', async () => {
    mockHasLibrary.mockResolvedValue(false);
    await renderPage();

    expect(screen.getByRole('link', { name: /import your resume/i }).getAttribute('href')).toBe(
      '/library',
    );
    expect(screen.queryByLabelText(/job description/i)).toBeNull();
  });

  it('[machine] zero jobs WITH a library renders the empty-state line', async () => {
    await renderPage();
    expect(screen.getByText(/no jobs yet — paste a job description above/i)).toBeTruthy();
  });

  it('[machine] zero jobs WITHOUT a library does not repeat the message', async () => {
    mockHasLibrary.mockResolvedValue(false);
    await renderPage();
    expect(screen.queryByText(/no jobs yet/i)).toBeNull();
  });

  it('[machine] NO JD text can leak onto the list (plan D1s narrow projection)', async () => {
    // `JobListRow` structurally has no jdRaw/jd/ledger/fit, so this is really a guard
    // against a future widening of listJobs's projection.
    mockListJobs.mockResolvedValue(JOB_LIST_FIXTURE);
    const { container } = await renderPage();

    const job = jobFixture();
    expect(container.textContent).not.toContain(job.jdRaw);
    expect(container.textContent).not.toContain('Production Kubernetes at scale');
    expect(container.textContent).not.toContain('Ran a 40-node EKS cluster');
  });

  it('[machine] an UnauthorizedError PROPAGATES and neither query runs', async () => {
    // Middleware already gates /jobs; reaching here unauthenticated means that gate
    // is broken, which must be loud rather than silently redirected.
    mockRequireUserId.mockRejectedValue(new Error('Unauthorized'));

    const { default: JobsPage } = await import('@/app/(app)/jobs/page');
    await expect(JobsPage()).rejects.toThrow(/unauthorized/i);
    expect(mockListJobs).not.toHaveBeenCalled();
    expect(mockHasLibrary).not.toHaveBeenCalled();
  });

  it('[machine] a THROWING hasLibrary propagates — it must NOT degrade into the "no library" CTA', async () => {
    // LIB-02 throws on stored-row drift. Catching it here would tell a user who HAS a
    // library to go import another one — a wrong CTA on top of a real bug.
    mockHasLibrary.mockRejectedValue(new Error('Stored library row does not match the Library schema'));

    const { default: JobsPage } = await import('@/app/(app)/jobs/page');
    await expect(JobsPage()).rejects.toThrow(/does not match the Library schema/);
  });

  it('[machine] a THROWING listJobs propagates rather than rendering an empty list', async () => {
    mockListJobs.mockRejectedValue(new Error('db exploded'));
    const { default: JobsPage } = await import('@/app/(app)/jobs/page');
    await expect(JobsPage()).rejects.toThrow(/db exploded/);
  });

  it('[machine] declares force-dynamic so per-user data is never statically cached', async () => {
    const mod = await import('@/app/(app)/jobs/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('[machine] BUILD GUARD: the page module imports cleanly with DATABASE_URL unset', async () => {
    // `next build`'s "Collecting page data" statically imports every PAGE module, and
    // db/index.ts THROWS at import time without DATABASE_URL. This page imports BOTH
    // query modules STATICALLY, which is only safe because each resolves `@/db/index`
    // lazily. Every other test here mocks them and would MASK a regression — this one
    // deliberately un-mocks them. FND-08 shipped exactly this bug.
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    vi.doUnmock('@/lib/db/queries/jobs');
    vi.doUnmock('@/lib/db/queries/library');
    // `@/lib/auth/session` stays MOCKED — un-mocking it pulls next-auth in, which
    // resolves `next/server` through its own nested node_modules and fails under jsdom
    // for reasons unrelated to DATABASE_URL (library/page.test.tsx explains it in full).

    await expect(import('@/app/(app)/jobs/page')).resolves.toBeDefined();

    // Sanity: the module that WOULD have blown up really does, so this test cannot
    // pass merely because DATABASE_URL happened to be set.
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
