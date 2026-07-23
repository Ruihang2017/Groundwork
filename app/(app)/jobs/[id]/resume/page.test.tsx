// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TAILORED_FIXTURE, LIBRARY_FIXTURE } from '@/app/(app)/jobs/[id]/resume/_fixtures/tailored-fixtures';

// TLR-02 Deliverable 7 (plan §3.14) — the server component's branch + auth/scoping + the
// build guard. The job's existence/ownership is guarded by [id]/layout.tsx, so this page
// never calls getJob/notFound.

const { mockRequireUserId, mockGetTailoredResume, mockGetLibrary } = vi.hoisted(() => ({
  mockRequireUserId: vi.fn(),
  mockGetTailoredResume: vi.fn(),
  mockGetLibrary: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireUserId: mockRequireUserId,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/db/queries/tailored-resumes', () => ({ getTailoredResume: mockGetTailoredResume }));
vi.mock('@/lib/db/queries/library', () => ({ getLibrary: mockGetLibrary }));

const TEST_USER_ID = 'user-abc-123';
const JOB_ID = 'job-1';

beforeEach(() => {
  mockRequireUserId.mockResolvedValue(TEST_USER_ID);
  mockGetTailoredResume.mockResolvedValue(TAILORED_FIXTURE);
  mockGetLibrary.mockResolvedValue(LIBRARY_FIXTURE);
});

afterEach(cleanup);
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function renderPage(id = JOB_ID) {
  const { default: ResumePage } = await import('@/app/(app)/jobs/[id]/resume/page');
  return render(await ResumePage({ params: Promise.resolve({ id }) }));
}

describe('ResumePage — branch selection', () => {
  it('[machine] no TailoredResume → the Generate trigger, and NO workspace', async () => {
    mockGetTailoredResume.mockResolvedValue(null);
    await renderPage();

    expect(screen.getByRole('button', { name: /generate tailored resume/i })).toBeTruthy();
    // The workspace surfaces are absent.
    expect(screen.queryByLabelText(/full draft \(markdown\)/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /mark as applied/i })).toBeNull();
  });

  it('[machine] a TailoredResume → the workspace with alignment, edits, editor', async () => {
    await renderPage();

    expect(screen.getByText('Present')).toBeTruthy();
    expect(screen.getAllByRole('checkbox').length).toBe(TAILORED_FIXTURE.edits.length);
    expect(screen.getByLabelText(/full draft \(markdown\)/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /mark as applied/i })).toBeTruthy();
    // The Generate trigger is NOT shown once a draft exists.
    expect(screen.queryByRole('button', { name: /generate tailored resume/i })).toBeNull();
  });

  it('[machine] the reload path renders an EMPTY dropped header (dropped is not persisted)', async () => {
    const { container } = await renderPage();
    expect(container.textContent).not.toMatch(/item.*dropped/i);
  });
});

describe('ResumePage — auth, scoping and failure paths', () => {
  it('[machine] reads with the SESSION userId and the awaited params.id (PRD §8.3)', async () => {
    await renderPage();
    expect(mockGetTailoredResume).toHaveBeenCalledWith(TEST_USER_ID, JOB_ID);
    expect(mockGetLibrary).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it('[machine] an UnauthorizedError propagates and no query runs', async () => {
    mockRequireUserId.mockRejectedValue(new Error('Unauthorized'));
    const { default: ResumePage } = await import('@/app/(app)/jobs/[id]/resume/page');

    await expect(ResumePage({ params: Promise.resolve({ id: JOB_ID }) })).rejects.toThrow(/unauthorized/i);
    expect(mockGetTailoredResume).not.toHaveBeenCalled();
    expect(mockGetLibrary).not.toHaveBeenCalled();
  });

  it('[machine] a THROWING getLibrary propagates (loud-failure, not swallowed)', async () => {
    mockGetLibrary.mockRejectedValue(new Error('Stored library row does not match the Library schema'));
    const { default: ResumePage } = await import('@/app/(app)/jobs/[id]/resume/page');

    await expect(ResumePage({ params: Promise.resolve({ id: JOB_ID }) })).rejects.toThrow(
      /does not match the Library schema/,
    );
  });
});

describe('ResumePage — module contract', () => {
  it('[machine] declares force-dynamic', async () => {
    const mod = await import('@/app/(app)/jobs/[id]/resume/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('[machine] BUILD GUARD: imports cleanly with DATABASE_URL unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    vi.doUnmock('@/lib/db/queries/tailored-resumes');
    vi.doUnmock('@/lib/db/queries/library');

    await expect(import('@/app/(app)/jobs/[id]/resume/page')).resolves.toBeDefined();
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
