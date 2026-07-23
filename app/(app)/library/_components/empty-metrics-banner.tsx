import { countMissingMetrics } from '@/app/(app)/library/_lib/library-edits';
import type { Project } from '@/lib/schemas/entities';

// LIB-03 Deliverable 3 — the page-top tally, half of PRD §5.7's Library rule:
//
//   "导入后草稿确认流；项目无 metrics 时页顶红字盘点 + 卡片级警告"
//
// TWO distinct elements are required, not either/or: this banner (页顶红字盘点)
// AND the per-card warning in project-card.tsx (卡片级警告). This one exists to
// give the whole-library number at a glance; deleting either would fail §5.7.
//
// PRD §5.6: "空数组是合法且被显式展示的状态" — an empty `metrics` array is a legal
// state that must be SHOWN, not an error to hide or auto-fix. So this banner is
// informational red, not a blocker: nothing about it prevents saving.
//
// Pure and hook-free by design (no 'use client' needed): it takes projects in and
// returns markup, which is what makes "renders exactly when at least one project
// has no metrics" a two-line test.
//
// The exact copy and tone are this ticket's reading of "红字盘点" (the PRD gives
// intent, not wording). Per the ticket's Feedback obligation #2, if Horace's
// dogfood pass finds it insufficiently prominent, fix it here and log the change
// in docs/prd/03-library/README.md's changelog — no escalation needed.

// The repo's established danger colour (app/(app)/settings/page.tsx,
// delete-account-confirm.tsx). Reused deliberately so the '红字' the human
// acceptance item checks is a colour the rest of the app already uses. There is
// no CSS framework in this repo — every component styles inline.
const DANGER = '#b00020';

export default function EmptyMetricsBanner({
  projects,
}: {
  projects: readonly Project[];
}) {
  const total = projects.length;
  const missing = countMissingMetrics(projects);

  // Nothing to tally: either there are no projects at all, or every project
  // already carries at least one real number.
  if (total === 0 || missing === 0) return null;

  return (
    <p
      role="alert"
      // fontWeight rather than a nested <strong>: keeping the tally in ONE text
      // node is what lets tests (and screen readers) read it as a single string.
      style={{
        color: DANGER,
        fontWeight: 700,
        border: `1px solid ${DANGER}`,
        borderRadius: '4px',
        padding: '0.75rem 1rem',
        margin: '0 0 1rem',
      }}
    >
      {missing} of {total} {total === 1 ? 'project' : 'projects'}{' '}
      {missing === 1 ? 'has' : 'have'} no metrics — add real numbers from your resume so Fit
      and Tailor can cite evidence.
    </p>
  );
}
