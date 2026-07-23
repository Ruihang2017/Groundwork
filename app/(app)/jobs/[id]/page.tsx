import { notFound } from 'next/navigation';

import FitAutoRunner from '@/app/(app)/jobs/[id]/_components/fit-auto-runner';
import FitReportView from '@/app/(app)/jobs/[id]/_components/fit-report-view';
import { droppedFromLedger } from '@/app/(app)/jobs/[id]/_components/fit-view-model';
import { requireUserId } from '@/lib/auth/session';
import { getJob } from '@/lib/db/queries/jobs';

// FIT-03 Deliverable 7 — the FIT TAB, i.e. the Fit Report itself, rendered inside
// `[id]/layout.tsx`'s three-段 shell.
//
// TWO BRANCHES, and which one runs is the visible face of the two-call "Fit"
// architecture (04-fit/README.md open question #2, plan §6's ADR-0001 candidate):
//
//   fit already persisted  → render it server-side, with D8's PARTIAL dropped view
//                            (FIT-02 does not persist the raw discarded entries, so
//                            only layer 2's injections are recoverable here).
//   fit absent             → <FitAutoRunner>, which issues FIT-02's POST on mount and
//                            renders the report from THAT response — the only path on
//                            which the full `dropped` payload exists at all (D4).
//
// The branch tests BOTH `fit` and `ledger`. They are always written together
// (`attachLedgerAndFit` sets them in one statement) but the DATABASE does not enforce
// the pairing, and TypeScript demands the null check for `ledger` regardless. "Ledger
// without fit" is treated as "not yet fitted" — the runner produces both.
//
// PLAN D2 — this page reads the job AGAIN, independently of `layout.tsx`. App Router
// layouts cannot pass data to pages, and a shared `_lib/` reader is outside this
// ticket's declared file-scope. Two primary-key reads per detail request: accepted and
// documented, not hidden.
//
// E10 — `notFound()` throws and stays OUTSIDE any try/catch. `getJob` is not wrapped
// either: it throws on row drift (FIT-01's loud-failure policy), which must surface as
// an error rather than degrade into a 404.
//
// STATIC import of `@/lib/db/queries/jobs` — import-safe with no DATABASE_URL, pinned
// by a build guard in page.test.tsx (see JobsPage's header for the full reasoning).

export const dynamic = 'force-dynamic';

export default async function JobFitPage({ params }: { params: Promise<{ id: string }> }) {
  // E11 — Next 15 hands `params` as a Promise; a non-Promise type fails `next build`'s
  // generated route-type check, i.e. AFTER the tests are green.
  const { id } = await params;
  const userId = await requireUserId();

  const job = await getJob(userId, id);
  if (!job) notFound();

  if (job.fit === null || job.ledger === null) {
    return <FitAutoRunner jobId={id} />;
  }

  return (
    <FitReportView
      jd={job.jd}
      ledger={job.ledger}
      fit={job.fit}
      // D8: `partial: true` on every load after the run that produced the report.
      dropped={droppedFromLedger(job.ledger, job.jd)}
    />
  );
}
