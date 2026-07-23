// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREP_LOCKED_COPY } from '@/app/(app)/jobs/[id]/_components/job-tabs';
import { jobFixture } from '@/app/(app)/jobs/_fixtures/job-fixtures';
import type { JobStatus } from '@/lib/schemas/persisted';

// HONESTY NOTE: this file proves the shell's gating and copy. The Prep lock it asserts
// is a UX HINT, not an enforcement boundary — PRP-03 owns the real page-level check.
// A green run here is not "Prep is protected".

const { mockRequireUserId, mockGetJob, mockNotFound } = vi.hoisted(() => ({
  mockRequireUserId: vi.fn(),
  mockGetJob: vi.fn(),
  // The REAL notFound() throws. A non-throwing mock would let execution continue past
  // the guard and produce a green test for the wrong reason — the failure mode
  // app/(admin)/admin/page.test.tsx documents.
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
  vi.unstubAllEnvs();
});

async function renderLayout(status?: JobStatus) {
  if (status) mockGetJob.mockResolvedValue(jobFixture({ status }));
  const { default: JobLayout } = await import('@/app/(app)/jobs/[id]/layout');
  return render(
    await JobLayout({
      children: <p>TAB CONTENT</p>,
      params: Promise.resolve({ id: JOB_ID }),
    }),
  );
}

describe('JobLayout — the shared 3-tab shell (FIT-03 Deliverable 4)', () => {
  it('[machine] renders the company, role, status chip and its children', async () => {
    await renderLayout();
    expect(screen.getByRole('heading', { name: /northwind payments — staff platform engineer/i })).toBeTruthy();
    expect(screen.getByText('Screening')).toBeTruthy();
    expect(screen.getByText('TAB CONTENT')).toBeTruthy();
  });

  it('[machine] reads the job with the SESSION userId and the AWAITED params.id (PRD §8.3)', async () => {
    await renderLayout();
    expect(mockGetJob).toHaveBeenCalledWith(TEST_USER_ID, JOB_ID);
  });

  it('[machine] renders the Fit and Resume tabs with the right hrefs', async () => {
    await renderLayout();
    expect(screen.getByRole('link', { name: /^fit$/i }).getAttribute('href')).toBe('/jobs/job-1');
    // D15: this 404s until 05-tailor ships. Deliberate — see the component header.
    expect(screen.getByRole('link', { name: /^resume$/i }).getAttribute('href')).toBe(
      '/jobs/job-1/resume',
    );
  });
});

describe('JobLayout — the Prep lock (FIT-03 acceptance item 2; PRD §5.7 "拿到面邀后解锁")', () => {
  // The ticket asks for two tests; all four enum values are covered because the extra
  // two are free and a missed value would be a silent hole.
  it.each<JobStatus>(['screening', 'applied', 'closed'])(
    '[machine] status %s: Prep is NOT a link and carries the locked copy',
    async (status) => {
      await renderLayout(status);

      // D6: `disabled`/`aria-disabled` do not stop navigation on an <a>; the only
      // correct "non-navigable" implementation is to render no anchor at all.
      expect(screen.queryByRole('link', { name: /prep/i })).toBeNull();
      expect(screen.getByText(PREP_LOCKED_COPY, { exact: false })).toBeTruthy();
      // The word is still on screen so the user can see the third stage exists.
      expect(screen.getByText('Prep')).toBeTruthy();
    },
  );

  it('[machine] status interviewing: Prep IS a link and the locked copy is gone', async () => {
    await renderLayout('interviewing');

    expect(screen.getByRole('link', { name: /^prep$/i }).getAttribute('href')).toBe(
      '/jobs/job-1/prep',
    );
    expect(screen.queryByText(PREP_LOCKED_COPY, { exact: false })).toBeNull();
  });
});

describe('JobLayout — failure paths', () => {
  it('[machine] a missing job calls notFound() and renders NO tab nav', async () => {
    mockGetJob.mockResolvedValue(null);
    const { default: JobLayout } = await import('@/app/(app)/jobs/[id]/layout');

    await expect(
      JobLayout({ children: <p>TAB CONTENT</p>, params: Promise.resolve({ id: 'nope' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    // E10: notFound() throws, so nothing after the guard may have rendered.
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it("[machine] another user's job is INDISTINGUISHABLE from a missing one", async () => {
    // getJob returns null for both and refuses to distinguish them (PRD §8.3), so
    // there is no existence oracle to be had from this layout.
    mockGetJob.mockResolvedValue(null);
    const { default: JobLayout } = await import('@/app/(app)/jobs/[id]/layout');
    await expect(
      JobLayout({ children: null, params: Promise.resolve({ id: 'someone-elses' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('[machine] a THROWING getJob (row drift) propagates rather than 404-ing', async () => {
    mockGetJob.mockRejectedValue(new Error('Stored job row does not match the PersistedJob schema'));
    const { default: JobLayout } = await import('@/app/(app)/jobs/[id]/layout');

    await expect(
      JobLayout({ children: null, params: Promise.resolve({ id: JOB_ID }) }),
    ).rejects.toThrow(/does not match the PersistedJob schema/);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('[machine] an UnauthorizedError propagates and NO job read happens', async () => {
    mockRequireUserId.mockRejectedValue(new Error('Unauthorized'));
    const { default: JobLayout } = await import('@/app/(app)/jobs/[id]/layout');

    await expect(
      JobLayout({ children: null, params: Promise.resolve({ id: JOB_ID }) }),
    ).rejects.toThrow(/unauthorized/i);
    expect(mockGetJob).not.toHaveBeenCalled();
  });
});

describe('JobLayout — module contract', () => {
  it('[machine] declares force-dynamic', async () => {
    const mod = await import('@/app/(app)/jobs/[id]/layout');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('[machine] BUILD GUARD: imports cleanly with DATABASE_URL unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    vi.doUnmock('@/lib/db/queries/jobs');
    // `@/lib/auth/session` and `next/navigation` stay mocked, for the reasons
    // app/(app)/library/page.test.tsx records.

    await expect(import('@/app/(app)/jobs/[id]/layout')).resolves.toBeDefined();
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
