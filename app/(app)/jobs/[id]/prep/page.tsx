import { notFound } from 'next/navigation';

import LockScreen from '@/app/(app)/jobs/[id]/prep/_components/lock-screen';
import { requireUserId } from '@/lib/auth/session';
import { getJob } from '@/lib/db/queries/jobs';

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
// STATIC import of `@/lib/db/queries/jobs` — import-safe with DATABASE_URL unset via its
// memoized lazy dbIndex(), pinned by the build-guard test in page.test.tsx — exactly as the
// Fit and resume pages do. Do NOT add a top-level `@/db/index` import.

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

  // === UNLOCKED-STATE PLACEHOLDER — PRP-04 REPLACES THIS BLOCK ===
  // PRP-04 wires RESEARCH → REHEARSE + Brief rendering here. PRP-03 makes NO RESEARCH/REHEARSE
  // call, not even here (ticket Non-goals) — keep this a PURE render with ZERO fetch so both
  // "locked branch makes no API calls" and "unlocked placeholder makes no API calls" hold
  // until PRP-04 (a test pins zero fetch on every render). Per PRP-03 Feedback obligation #2,
  // PRP-04 may restructure this file freely but MUST preserve the locked-state behavior above
  // (the locked-branch tests + the button's behavior must still pass — regression-test them).
  return (
    <section aria-labelledby="prep-heading">
      <h2 id="prep-heading">Interview prep</h2>
      <p>Your interview brief will appear here.</p>
    </section>
  );
}
