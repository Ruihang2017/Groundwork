import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import JobTabs from '@/app/(app)/jobs/[id]/_components/job-tabs';
import StatusChip from '@/app/(app)/jobs/_components/status-chip';
import { requireUserId } from '@/lib/auth/session';
import { getJob } from '@/lib/db/queries/jobs';

// FIT-03 Deliverable 4 — THE SHARED JOB-DETAIL SHELL.
//
// ⚠️ CONTRACT THAT 05-tailor AND 06-prep DEPEND ON, per docs/prd/breakdown-plan.md §3:
// this file is the three-段 tab shell, created here, and those modules add their pages
// under `[id]/resume/**` and `[id]/prep/**` — "只在其子路由下新增页面，不改 layout
// 本身". They must NOT edit this file. If a later module genuinely needs something
// from the shell, that is a breakdown-plan question, not a quiet edit.
//
// PRD §5.7's Job 详情 row: "Fit / Resume / Prep 三段推进；Prep 在 interviewing 前锁定".
// The lock is computed here from `job.status` alone — no import from 06-prep (which
// does not exist yet in the DAG) is needed to render a non-navigable tab.
//
// PLAN D2 — THIS LAYOUT AND ITS PAGE EACH READ THE JOB. App Router layouts cannot
// hand data to their pages, and this ticket's file-scope does not include a `_lib/`
// folder to put a shared `cache()`d reader in (breakdown-plan §3 names
// `[id]/_components/**` and not `_lib`, and inventing a folder outside the declared
// scope is exactly what the file-scope table exists to prevent). So a job-detail
// request costs TWO `SELECT … WHERE id=$1 AND user_id=$2 LIMIT 1` — both on the
// primary key. Accepted and documented rather than worked around.
//
// `notFound()` covers BOTH "no such job" and "another user's job": `getJob` returns
// `null` for both and refuses to distinguish them by design (PRD §8.3). There is no
// existence oracle here — an attacker guessing ids gets a byte-identical 404 either
// way.
//
// E10 — `notFound()` WORKS BY THROWING and is deliberately OUTSIDE any try/catch. A
// catch around it would swallow the 404 signal and render the shell for a job that
// does not exist.
//
// `getJob` is NOT wrapped in try/catch either: it throws on stored-row drift (FIT-01's
// loud-failure policy), which is a real bug and must surface as an error, not degrade
// into a 404. Same policy as LIB-03's `getLibrary`.
//
// NO `generateMetadata` — it would require a THIRD `getJob` call per request for a
// browser-tab title. Documented omission, not an oversight.

export const dynamic = 'force-dynamic';

export default async function JobLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  // E11 — Next 15 hands `params` as a PROMISE. A non-Promise type type-checks in
  // isolation and fails `next build`'s generated route-type check, i.e. it fails LATE,
  // after the tests are green.
  const { id } = await params;
  const userId = await requireUserId();

  const job = await getJob(userId, id);
  if (!job) notFound();

  return (
    <section style={{ maxWidth: '56rem' }}>
      <h1 style={{ margin: '0 0 0.25rem' }}>
        {job.company} — {job.role}
      </h1>
      <p style={{ margin: '0 0 1rem' }}>
        <StatusChip status={job.status} />
      </p>

      <JobTabs jobId={id} status={job.status} />

      {children}
    </section>
  );
}
