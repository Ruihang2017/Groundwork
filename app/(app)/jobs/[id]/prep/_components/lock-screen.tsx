import StatusTransitionButton from '@/app/(app)/jobs/[id]/prep/_components/status-transition-button';

// PRP-03 Deliverable 1 (plan §2.2) — the LOCKED-state UI for the Prep tab: PRD §5.4/§5.7's
// "拿到面邀后解锁" copy in English (§5.8 "UI 英文") plus the "I got the interview" button.
//
// A presentational SERVER component — NO 'use client' (no hooks, no browser API). It renders
// the client `StatusTransitionButton` as a child, exactly as the server Fit page renders the
// client `FitAutoRunner`. Takes `{ jobId }` to hand to the button.
//
// WHY THIS OWNS ITS OWN COPY and does NOT import `PREP_LOCKED_COPY` from FIT-03's
// job-tabs.tsx (plan §2.2 / §5 Q3):
//   (a) the two strings serve different UI contexts — job-tabs.tsx's is a terse inline tab
//       hint ("Unlocked after you get an interview invite"); this is a full-page locked state
//       with an explanatory sentence + a call-to-action button, and they may legitimately read
//       differently;
//   (b) importing a constant from a 04-fit component would couple 06-prep to another module's
//       UI internals — exactly the cross-module coupling docs/prd/breakdown-plan.md §3's
//       per-module-duplication decision avoids (the same reason PRP-04 builds its own
//       dropped-count-header.tsx rather than importing FIT-03's);
//   (c) exporting `PREP_UNLOCK_COPY` here lets the lock-screen test assert the copy without
//       hardcoding a literal that can drift.
// The wording follows the ticket's Deliverable 1; Feedback obligation #1 permits an i18n-tone
// refinement, logged in 06-prep/README.md's changelog if changed (it was not).

/** PRD §5.4/§5.7 "拿到面邀后解锁", in English (§5.8 "UI 英文"). Exported so the copy and
 *  its test cannot drift. */
export const PREP_UNLOCK_COPY = 'Prep unlocks after you get an interview.';

export default function LockScreen({ jobId }: { jobId: string }) {
  return (
    <section aria-labelledby="prep-locked-heading">
      <h2 id="prep-locked-heading">Prep is locked</h2>
      <p>{PREP_UNLOCK_COPY}</p>
      <StatusTransitionButton jobId={jobId} />
    </section>
  );
}
