import { notFound } from 'next/navigation';

import BriefGenerator from '@/app/(app)/jobs/[id]/prep/_components/brief-generator';
import BriefView from '@/app/(app)/jobs/[id]/prep/_components/brief-view';
import LockScreen from '@/app/(app)/jobs/[id]/prep/_components/lock-screen';
import { projectNameMap } from '@/app/(app)/jobs/[id]/prep/_lib/project-names';
import { requireUserId } from '@/lib/auth/session';
import { getBrief } from '@/lib/db/queries/briefs';
import { getJob } from '@/lib/db/queries/jobs';
import { getLibrary } from '@/lib/db/queries/library';

// PRP-03 Deliverable 3 — THE PREP TAB (PRD §5.7's "Fit / Resume / Prep 三段推进"), rendered
// as `{children}` inside FIT-03's `[id]/layout.tsx` three-段 shell. Modelled line-for-line on
// the Fit tab `[id]/page.tsx`.
//
// THE PAGE-LEVEL LOCK (plan S2 / R4). PRD §5.4/§5.7: Prep is LOCKED until
// `job.status === 'interviewing'` (the user clicking "I got the interview"). FIT-03's
// job-tabs.tsx greys out the Prep nav link, but its own header says that lock is only a UX
// HINT — typing /jobs/<id>/prep bypasses it. THE `status !== 'interviewing'` BRANCH BELOW IS
// THE REAL PAGE-LEVEL CHECK job-tabs.tsx promises. It withholds the unlocked branch — which
// PRP-04 will wire to paid RESEARCH/REHEARSE calls — from any non-interviewing job, even when
// the URL is typed directly. Nobody may later delete this check on the grounds that "the tab
// is already locked". (Defense in depth: PRP-01's RESEARCH route independently returns
// 403 not_interviewing server-side before spending money.)
//
// END-TO-END FLOW this delivers (stated here so the Reviewer and PRP-04 see the whole picture):
//   1. A non-interviewing job's tab nav shows Prep as a non-navigable <span>, so the only way
//      to reach here is typing the URL. Doing so renders <LockScreen> (this page-level gate).
//   2. The user clicks "I got the interview" → PATCH /api/jobs/<id> { status: 'interviewing' }
//      → 200 → router.refresh().
//   3. The refresh re-runs the server tree: layout.tsx re-reads the job and job-tabs.tsx now
//      renders Prep as a real <Link>; this page re-reads the job, sees 'interviewing', and
//      renders the unlocked placeholder (PRP-04 later makes this the real brief).
//
// PLAN D2 — this page reads the job AGAIN, independently of `layout.tsx`. App Router layouts
// cannot pass data to pages, and the Prep page's entire branch IS `job.status`, so it must
// read the job. Two primary-key reads per detail request: FIT-03's accepted, documented cost.
// (Unlike TLR-02's resume/page.tsx, which reads a different entity and leans on the layout's
// guard, this page follows the Fit tab's precedent — `getJob` + `if (!job) notFound()` — so
// the guard is defensive and the module contract is testable.)
//
// `notFound()` throws and stays OUTSIDE any try/catch. `getJob` is NOT wrapped either: it
// throws on stored-row drift (FIT-01's loud-failure policy), a real bug that must surface as
// an error rather than degrade into a 404. `requireUserId` throws `UnauthorizedError` —
// propagated, not wrapped (middleware already gated /jobs/*).
//
// STATIC import of `@/lib/db/queries/{jobs,briefs,library}` — all three import-safe with
// DATABASE_URL unset via their memoized lazy dbIndex(), pinned by the build-guard test in
// page.test.tsx — exactly as the Fit and resume pages do. Do NOT add a top-level `@/db/index`
// import.
//
// PRP-04 EXTENSION (Deliverable 7). The locked branch + all guard scaffolding above are
// preserved verbatim (PRP-03 Feedback obligation #2); ONLY the unlocked placeholder is
// replaced. The unlocked branch adds TWO session-scoped reads on top of getJob — getBrief (the
// job's Brief, or null) and getLibrary (for the projectId→name map) — both of which THROW on
// stored-row drift (loud-failure policy) and are NOT wrapped. Two sub-branches (D15):
//   • a Brief EXISTS → render <BriefView> server-side (the reload path: NO generation, NO
//     fetch — acceptance item 5). getBrief returns briefs.ts's RELAXED PersistedBrief
//     (rehearse.questions may be < 5, plan D4 / PRP-02 D5); it is consumed as DATA and MUST
//     NOT be re-parsed against the strict FND-03 Brief (briefs.ts header). `dropped` is not
//     persisted, so the reload path passes 0 / [].
//   • no Brief → hand off to <BriefGenerator> (the only path that fetches — RESEARCH→REHEARSE).

export const dynamic = 'force-dynamic';

export default async function JobPrepPage({ params }: { params: Promise<{ id: string }> }) {
  // Next 15 hands `params` as a Promise; a non-Promise type fails `next build`'s generated
  // route-type check, i.e. AFTER the tests are green.
  const { id } = await params;
  const userId = await requireUserId();

  const job = await getJob(userId, id); // scoped to the session user (PRD §8.3).
  if (!job) notFound(); // absent OR another user's → byte-identical 404. Outside any try/catch.

  // PRD §5.4/§5.7: Prep is LOCKED until job.status === 'interviewing'.
  if (job.status !== 'interviewing') {
    return <LockScreen jobId={id} />;
  }

  // === UNLOCKED (job.status === 'interviewing'): render the brief, or generate it ===
  // PRP-04 Deliverable 7. Two reads, both session-scoped (PRD §8.3), both import-safe with
  // DATABASE_URL unset (lazy dbIndex — build-guard test). getBrief/getLibrary THROW on row
  // drift (loud-failure policy) — NOT wrapped (a drifted row is a 500-class bug, not a 404).
  const [brief, library] = await Promise.all([getBrief(userId, id), getLibrary(userId)]);
  const projectNames = projectNameMap(library);

  // D15 — Brief exists → render it server-side (reload path: NO generation, NO fetch;
  // acceptance item 5). `brief` is briefs.ts's RELAXED PersistedBrief (rehearse.questions may
  // be < 5, D4/PRP-02 D5) — consumed as data, NOT re-parsed against strict Brief. `dropped` is
  // not persisted, so the reload path passes 0 / [] (D3 / Deliverable 6).
  if (brief) {
    return (
      <BriefView
        intel={brief.intel}
        rehearse={brief.rehearse}
        ledger={job.ledger}
        projectNames={projectNames}
        droppedCount={0}
        droppedItems={[]}
      />
    );
  }

  // No Brief yet → the client generator runs RESEARCH → REHEARSE and renders BriefView from the
  // REHEARSE response (D2/D3). It receives job.ledger (recap) + projectNames (question
  // grouping); it does NOT need the library itself (REHEARSE re-reads it server-side).
  return <BriefGenerator jobId={id} ledger={job.ledger} projectNames={projectNames} />;
}
