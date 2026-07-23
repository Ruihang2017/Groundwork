import JobListItem from '@/app/(app)/jobs/_components/job-list-item';
import NewJobForm from '@/app/(app)/jobs/_components/new-job-form';
import { requireUserId } from '@/lib/auth/session';
import { listJobs } from '@/lib/db/queries/jobs';
import { hasLibrary } from '@/lib/db/queries/library';

// FIT-03 Deliverable 3 — the /jobs route. PRD §5.7's Jobs 列表 row in full: "每个 job
// 带状态 chip：screening → applied → interviewing → closed；无库时禁止新建 job，CTA
// 引导导入简历".
//
// Lives under app/(app)/**, so middleware.ts's gate covers it THE MOMENT THIS FILE
// EXISTS — that gate is an allowlist-by-omission (PUBLIC_PATHS is `/`, `/signin`,
// `/privacy`, `/tos`). No middleware change was needed and none was made;
// `middleware.ts` is 01-foundation's file.
//
// A THIN async Server Component, modelled line-for-line on app/(app)/library/page.tsx:
// it resolves identity, reads, and hands plain JSON down. All state lives in
// new-job-form.tsx.
//
// STATIC import of both query modules is correct and deliberate, not an oversight of
// the build-time hazard that bit FND-08. Both resolve `@/db/index` LAZILY at call time
// and are import-safe with no DATABASE_URL (their own headers say they were written
// that way precisely so a server component could import them statically). A build
// guard in page.test.tsx pins it, and `next build` runs with DATABASE_URL unset.
//
// `requireUserId()` IS ALLOWED TO THROW (LIB-03's recorded decision, same reasoning):
// middleware gates /jobs on every request, so an UnauthorizedError here means that
// gate is broken, and that must be LOUD rather than silently redirected. No
// `redirect('/signin')`.
//
// `hasLibrary()` IS DELIBERATELY NOT WRAPPED IN try/catch. It THROWS on stored-row
// drift (LIB-02's loud-failure policy). Catching that would render "import your
// resume" to a user who HAS a library — a wrong CTA on top of a real bug.
//
// KNOWN GAP, reported not fixed (plan §5 Q1): there is NO navigation entry point to
// /jobs. app/layout.tsx's header links only "Groundwork" and sign-out, and both it and
// app/(app)/home/page.tsx are 01-foundation's files, outside this ticket's file-scope.
// /library shipped with the identical gap. Flagged for the P2 dogfood pass and for
// Horace to decide whether a follow-up ticket adds an app-shell nav.

export const metadata = {
  title: 'Jobs — Groundwork',
};

// This page reads per-user data and must never be statically cached. Local and
// explicit so it survives a future app/layout.tsx edit.
export const dynamic = 'force-dynamic';

export default async function JobsPage() {
  const userId = await requireUserId();

  // Two independent reads: a user can have a library and no jobs, or (transiently,
  // after an import that was undone) neither.
  const [jobs, libraryPresent] = await Promise.all([listJobs(userId), hasLibrary(userId)]);

  return (
    <section style={{ maxWidth: '56rem' }}>
      <h1>Jobs</h1>

      {/* Form ABOVE the list: PRD §4 S2 makes pasting a JD the primary action of this
          page ("全选粘贴 JD → 30s 内拿到 Fit Report"), not browsing history. */}
      <NewJobForm hasLibrary={libraryPresent} />

      {jobs.length === 0 ? (
        libraryPresent ? (
          <p>No jobs yet — paste a job description above to screen your first one.</p>
        ) : null /* The form's own CTA already carries the message; a second empty-state
                    paragraph would just repeat it. */
      ) : (
        jobs.map((job) => <JobListItem key={job.id} job={job} />)
      )}
    </section>
  );
}
