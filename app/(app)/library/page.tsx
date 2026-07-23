import LibraryWorkspace from '@/app/(app)/library/_components/library-workspace';
import { requireUserId } from '@/lib/auth/session';
import { getLibrary, getResume } from '@/lib/db/queries/library';

// LIB-03 Deliverable 5 — the /library route.
//
// Lives under app/(app)/**, so middleware.ts's default auth gate covers it the
// moment the file exists (the gate is an allowlist-by-omission: PUBLIC_PATHS is
// `/`, `/signin`, `/privacy`, `/tos`). No matcher change was needed and none was
// made.
//
// A THIN async Server Component on purpose: it resolves identity, reads, and
// hands plain JSON to the client orchestrator. All state and every mutation live
// in library-workspace.tsx. Keeping the returned tree free of async children is
// also what keeps `render(await LibraryPage())` viable in a component test.
//
// STATIC import of `@/lib/db/queries/library` is correct and deliberate, not an
// oversight of the build-time hazard that bit FND-08. That module is
// import-safe with no DATABASE_URL — it resolves `@/db/index` lazily at CALL time
// and its own header says it was written that way "precisely so this ticket's
// server component can import it statically". `page.test.tsx` pins this with a
// build guard that imports this module with DATABASE_URL blank and no mocks, and
// `next build` runs with DATABASE_URL unset in CI.
//
// `requireUserId()` IS ALLOWED TO THROW. Middleware gates /library on every
// request, so an UnauthorizedError here means that gate is broken — which should
// be loud, not silently redirected. Deliberately no `redirect('/signin')` and no
// `next/navigation` import. (Handed to the Reviewer as docs/plans/LIB-03.md §5 Q4.)
//
// `getLibrary()` IS DELIBERATELY NOT WRAPPED IN try/catch. It throws — rather
// than returning null — when a stored row fails `Library.safeParse`, which is a
// recorded LIB-02 decision ("loud beats silently-wrong"). Catching that and
// rendering the "no library yet" upload flow would invite the user to import a
// SECOND library over a corrupted one, the precise failure LIB-02 rejected. Let
// it propagate to the error boundary.
//
// `resumeMd` is read here and handed down for the save round-trip only. It is
// never rendered — v1 has no PRD-named action that edits it.

export const metadata = {
  title: 'Library — Groundwork',
};

// Documentation rather than a behaviour change: app/layout.tsx is already
// force-dynamic and every route in the current build output is ƒ (Dynamic). This
// makes the intent local and immune to a future layout edit — this page reads
// per-user data and must never be statically cached.
export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  const userId = await requireUserId();

  // Two independent reads, not a join: `libraries` and `resumes` have no FK to
  // each other (LIB-02), and a user can have one without the other.
  const [library, resume] = await Promise.all([getLibrary(userId), getResume(userId)]);

  return (
    <section style={{ maxWidth: '56rem' }}>
      <h1>Library</h1>
      <LibraryWorkspace
        initialLibrary={library}
        initialResumeMd={resume?.sourceMd ?? null}
      />
    </section>
  );
}
