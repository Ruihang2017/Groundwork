import Link from 'next/link';

import type { JobStatus } from '@/lib/schemas/persisted';

// FIT-03 Deliverable 4's nav — PRD §5.7's Job 详情 row, quoted verbatim: "Fit /
// Resume / Prep 三段推进；Prep 在 interviewing 前锁定（文案：'拿到面邀后解锁'）".
//
// PLAN D6 — "LOCKED" MEANS NOT AN ANCHOR. When the tab is locked this renders a
// `<span>`, not an `<a>`. That is not a stylistic choice: `disabled` IS NOT A VALID
// ATTRIBUTE on `<a>`, and `aria-disabled` does not stop navigation — an
// `<a disabled href="…">` is fully clickable in every browser. The only correct
// "non-navigable" implementation is to not render an anchor at all. It also makes the
// acceptance assertion crisp: `queryByRole('link', { name: /prep/i })` is null when
// locked and non-null when unlocked.
//
// ⚠️ THIS LOCK IS A UX HINT, NOT AN ENFORCEMENT BOUNDARY. Typing /jobs/<id>/prep
// bypasses it entirely. The ticket says so explicitly, and PRP-03 owns the REAL
// page-level check at app/(app)/jobs/[id]/prep/page.tsx. Nobody may later delete
// PRP-03's own check on the grounds that "the tab is already locked" (plan R4).
//
// PLAN D5 — NO ACTIVE-TAB HIGHLIGHT. Highlighting the current tab needs
// `useSelectedLayoutSegment()`/`usePathname()`, i.e. converting this into a client
// component — and (verified at planning time) that hook returns `null` under jsdom
// with no router provider, so the highlight would be UNTESTABLE. PRD §5.7 requires
// "Fit / Resume / Prep 三段推进", not a highlight. A deliberate omission, not an
// oversight.
//
// PLAN D15/§5 Q6 — THE RESUME AND PREP LINKS 404 UNTIL 05-tailor / 06-prep SHIP.
// That is deliberate and time-boxed, not a defect: docs/prd/breakdown-plan.md §3
// requires those modules to add pages UNDER this layout without editing the layout
// itself ("只在其子路由下新增页面，不改 layout 本身"), so rendering a placeholder now
// would force exactly the edit that rule forbids.

/** PRD's "拿到面邀后解锁", in English (§5.8's "UI 英文"). */
export const PREP_LOCKED_COPY = 'Unlocked after you get an interview invite';

const navStyle = {
  borderBottom: '1px solid #d0d0d0',
  display: 'flex',
  gap: '1rem',
  margin: '0 0 1.5rem',
  padding: '0 0 0.5rem',
} as const;

export default function JobTabs({ jobId, status }: { jobId: string; status: JobStatus }) {
  const prepUnlocked = status === 'interviewing';

  return (
    <nav aria-label="Job sections" style={navStyle}>
      <Link href={`/jobs/${jobId}`}>Fit</Link>
      <Link href={`/jobs/${jobId}/resume`}>Resume</Link>

      {prepUnlocked ? (
        <Link href={`/jobs/${jobId}/prep`}>Prep</Link>
      ) : (
        <span style={{ color: '#6b6b6b' }}>
          {/* NOT an anchor — see D6 in the header. */}
          <span>Prep</span> <small>({PREP_LOCKED_COPY})</small>
        </span>
      )}
    </nav>
  );
}
