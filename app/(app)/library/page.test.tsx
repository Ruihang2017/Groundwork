// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRAFT_LIBRARY_FIXTURE,
  RESUME_MD_FIXTURE,
} from '@/app/(app)/library/_fixtures/library-fixtures';

// The two server-side modules the page reaches. `vi.hoisted` keeps STABLE mock
// references across `vi.resetModules()`, the pattern app/api/parse/route.test.ts
// uses for the same reason.
const { mockRequireUserId, mockGetLibrary, mockGetResume } = vi.hoisted(() => ({
  mockRequireUserId: vi.fn(),
  mockGetLibrary: vi.fn(),
  mockGetResume: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireUserId: mockRequireUserId,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/db/queries/library', () => ({
  getLibrary: mockGetLibrary,
  getResume: mockGetResume,
}));

const TEST_USER_ID = 'user-abc-123';

beforeEach(() => {
  mockRequireUserId.mockResolvedValue(TEST_USER_ID);
  mockGetLibrary.mockResolvedValue(null);
  mockGetResume.mockResolvedValue(null);
});

afterEach(cleanup);
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

async function renderPage() {
  const { default: LibraryPage } = await import('@/app/(app)/library/page');
  render(await LibraryPage());
}

describe('LibraryPage (LIB-03 Deliverable 5)', () => {
  it('[machine] scopes both reads to the SESSION userId (PRD §8.3)', async () => {
    await renderPage();
    expect(mockGetLibrary).toHaveBeenCalledWith(TEST_USER_ID);
    expect(mockGetResume).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it('[machine] with no library, renders the import entry point and no project cards', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: /^library$/i })).toBeTruthy();
    expect(screen.getByLabelText(/resume file/i)).toBeTruthy();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('[machine] with a library, renders the banner, one card per project, and NO upload form', async () => {
    mockGetLibrary.mockResolvedValue(DRAFT_LIBRARY_FIXTURE);
    mockGetResume.mockResolvedValue({ sourceMd: RESUME_MD_FIXTURE, updatedAt: Date.now() });

    await renderPage();

    expect(screen.getByRole('heading', { name: /^library$/i })).toBeTruthy();
    // PRD §5.7's two required elements: page-top tally AND per-card warning.
    expect(screen.getByText(/1 of 2 projects has no metrics/i)).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(
      DRAFT_LIBRARY_FIXTURE.projects.length,
    );
    expect(screen.getByText(/no metrics — add a real number/i)).toBeTruthy();
    expect(screen.queryByLabelText(/resume file/i)).toBeNull();
  });

  it('[machine] never renders resumeMd on the page', async () => {
    mockGetLibrary.mockResolvedValue(DRAFT_LIBRARY_FIXTURE);
    mockGetResume.mockResolvedValue({ sourceMd: RESUME_MD_FIXTURE, updatedAt: Date.now() });

    const { default: LibraryPage } = await import('@/app/(app)/library/page');
    const { container } = render(await LibraryPage());

    expect(container.textContent).not.toContain('Immersive Software Engineering Bootcamp');
  });

  it('[machine] a schema-drifted stored row PROPAGATES — it must not degrade to "no library"', async () => {
    // LIB-02's `getLibrary` throws rather than returning null on shape drift
    // ("loud beats silently-wrong"). Catching it here and showing the upload flow
    // would invite the user to import a SECOND library over a corrupted one.
    mockGetLibrary.mockRejectedValue(new Error('Stored library row does not match the Library schema'));

    const { default: LibraryPage } = await import('@/app/(app)/library/page');
    await expect(LibraryPage()).rejects.toThrow(/does not match the Library schema/);
  });

  it('[machine] an UnauthorizedError propagates (middleware already gates /library)', async () => {
    mockRequireUserId.mockRejectedValue(new Error('Unauthorized'));

    const { default: LibraryPage } = await import('@/app/(app)/library/page');
    await expect(LibraryPage()).rejects.toThrow(/unauthorized/i);
    // Auth is checked BEFORE any read.
    expect(mockGetLibrary).not.toHaveBeenCalled();
    expect(mockGetResume).not.toHaveBeenCalled();
  });

  it('[machine] declares force-dynamic so per-user data is never statically cached', async () => {
    const mod = await import('@/app/(app)/library/page');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('[machine] the page module imports cleanly with DATABASE_URL unset (build guard)', async () => {
    // `next build`'s "Collecting page data" statically imports every PAGE module,
    // and db/index.ts THROWS at import time without DATABASE_URL. This page
    // imports `@/lib/db/queries/library` STATICALLY, which is only safe because
    // that module resolves `@/db/index` lazily. Every other test here mocks it and
    // would therefore MASK a regression — this one deliberately un-mocks it.
    // FND-08 shipped exactly this bug and had to bounce-fix it.
    vi.stubEnv('DATABASE_URL', '');
    vi.resetModules();
    vi.doUnmock('@/lib/db/queries/library');
    // `@/lib/auth/session` stays MOCKED, exactly as app/api/parse/route.test.ts
    // keeps `@/auth` mocked in its own build guard: un-mocking it pulls next-auth
    // in, which resolves `next/server` through its own nested node_modules and
    // fails under the jsdom environment for reasons that have nothing to do with
    // DATABASE_URL. That import chain is separately known-safe (its DB access is
    // deferred into a request-time factory), and the real `pnpm build` with
    // DATABASE_URL unset is the end-to-end check.

    await expect(import('@/app/(app)/library/page')).resolves.toBeDefined();

    // Sanity: the module that would have blown up really does blow up, so this
    // test cannot pass merely because DATABASE_URL happened to be set.
    await expect(import('@/db/index')).rejects.toThrow(/DATABASE_URL/);
  });
});
