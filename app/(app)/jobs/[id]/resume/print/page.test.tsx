// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TAILORED_FIXTURE } from '@/app/(app)/jobs/[id]/resume/_fixtures/tailored-fixtures';

// TLR-02 Deliverable 6 (plan §3.15 / D2) — the standalone print route: prints the PERSISTED
// draft, or a "generate one first" message when none exists. Does NOT notFound() (the job
// exists; only the draft does not).

const { mockRequireUserId, mockGetTailoredResume } = vi.hoisted(() => ({
  mockRequireUserId: vi.fn(),
  mockGetTailoredResume: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireUserId: mockRequireUserId,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/db/queries/tailored-resumes', () => ({ getTailoredResume: mockGetTailoredResume }));

const TEST_USER_ID = 'user-abc-123';
const JOB_ID = 'job-1';

beforeEach(() => {
  mockRequireUserId.mockResolvedValue(TEST_USER_ID);
  mockGetTailoredResume.mockResolvedValue(TAILORED_FIXTURE);
});

afterEach(cleanup);
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function renderPrint(id = JOB_ID) {
  const { default: ResumePrintPage } = await import('@/app/(app)/jobs/[id]/resume/print/page');
  return render(await ResumePrintPage({ params: Promise.resolve({ id }) }));
}

describe('ResumePrintPage', () => {
  it('[machine] no draft → the "generate one first" message + back link, and NO #print-root', async () => {
    mockGetTailoredResume.mockResolvedValue(null);
    const { container } = await renderPrint();

    expect(screen.getByText(/no tailored draft yet — generate one first/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /back to the resume editor/i }).getAttribute('href')).toBe(
      '/jobs/job-1/resume',
    );
    expect(container.querySelector('#print-root')).toBeNull();
  });

  it('[machine] a draft → a single #print-root containing the rendered draft', async () => {
    const { container } = await renderPrint();

    const printRoots = container.querySelectorAll('#print-root');
    expect(printRoots).toHaveLength(1);
    // The persisted draft is rendered (its heading text appears).
    expect(printRoots[0].textContent).toContain('Ada Lovelace');
    // A print button and a back link exist (both outside #print-root, hidden in print).
    expect(screen.getByRole('button', { name: /print \/ save as pdf/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /back to editor/i })).toBeTruthy();
  });

  it('[machine] reads with the SESSION userId and awaited params.id', async () => {
    await renderPrint();
    expect(mockGetTailoredResume).toHaveBeenCalledWith(TEST_USER_ID, JOB_ID);
  });

  it('[machine] declares force-dynamic', async () => {
    const mod = await import('@/app/(app)/jobs/[id]/resume/print/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('[machine] BUILD GUARD: imports cleanly with DATABASE_URL unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    vi.doUnmock('@/lib/db/queries/tailored-resumes');

    await expect(import('@/app/(app)/jobs/[id]/resume/print/page')).resolves.toBeDefined();
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
