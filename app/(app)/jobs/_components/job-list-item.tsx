import Link from 'next/link';

import StatusChip from '@/app/(app)/jobs/_components/status-chip';
import type { JobListRow } from '@/lib/db/queries/jobs';

// FIT-03 Deliverable 3 — one row of PRD §5.7's Jobs 列表.
//
// `import type { JobListRow }` is TYPE-ONLY and that is load-bearing, not stylistic
// (plan E12): a VALUE import of `@/lib/db/queries/jobs` pulls `drizzle-orm` and
// `@/db/schema` in behind it. A type import is fully erased.
//
// STRUCTURALLY INCAPABLE OF LEAKING JD TEXT. `JobListRow` is a narrow projection with
// no `jdRaw`, `jd`, `ledger` or `fit` (plan D1), so this component cannot render the
// user's job-description corpus even by accident. That is the point of the projection
// — the guarantee is in the type, not in a reviewer's vigilance.
//
// `<article>` matches LIB-03's project-card.tsx convention, so `getAllByRole('article')`
// counts rows in the page test.
//
// E6 — DATE FORMATTING. `createdAt` is epoch-ms. `toLocaleDateString()` is locale- AND
// timezone-dependent, which makes any assertion on it flaky across machines and CI, so
// this renders a fixed ISO calendar date (`YYYY-MM-DD`) via `toISOString()`. Chosen
// deliberately over "render a locale date and don't assert it": a stable string is
// worth more than a prettier one here, and it adds no dependency (the ticket allows
// no date library).
//
// KNOWN AND DELIBERATE (plan R7): a job whose Fit never completed looks IDENTICAL to a
// completed one in this list — the user only finds out by clicking (and paying). A
// "not yet screened" badge would require reading `fit` in `listJobs`, which reverses
// D1's privacy/blast-radius decision. Recorded as an exclusion, and worth watching in
// the P2 dogfood pass.

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export default function JobListItem({ job }: { job: JobListRow }) {
  return (
    <article
      style={{
        border: '1px solid #d0d0d0',
        borderRadius: '4px',
        padding: '0.75rem 1rem',
        margin: '0 0 0.75rem',
      }}
    >
      <p style={{ margin: '0 0 0.25rem' }}>
        {/* The accessible name carries company AND role — "Open" alone would give a
            screen-reader user a list of identical links. */}
        <Link href={`/jobs/${job.id}`}>
          {job.company} — {job.role}
        </Link>
      </p>
      <p style={{ margin: 0, color: '#555' }}>
        <StatusChip status={job.status} /> <span>Added {isoDate(job.createdAt)}</span>
      </p>
    </article>
  );
}
