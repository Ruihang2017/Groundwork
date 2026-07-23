'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

// PRP-03 Deliverable 2 (plan §2.3) — the "I got the interview" trigger, PRD §5.4's
// "我拿到面试了" in English (§5.8 "UI 英文").
//
// 06-prep/README.md's decision (mirrored from TLR-02's mark-applied-button): the
// interviewing transition is a manual, PRP-03-owned action calling FIT-01's existing
// generic status route — NO new API route. This component is mark-applied-button.tsx
// with exactly TWO deltas so the Reviewer reviews a small diff:
//   1. Body is EXACTLY `{ status: 'interviewing' }` (acceptance item 2), not 'applied'.
//   2. On 200 it calls `router.refresh()` (the ticket's explicit "Next.js router
//      refresh") instead of confirming in place.
//
// THE router.refresh() DECISION (plan §2.3 / Q1 / R3 — the repo's FIRST useRouter use):
// `router.refresh()` (App Router) re-fetches the current route's server components in
// place — re-running page.tsx's status branch AND layout.tsx's tab nav — WITHOUT a full
// document reload or losing client state, which is exactly this ticket's need. Imported
// from `next/navigation` (App Router), NEVER `next/router` (the Pages-Router hook has no
// `.refresh()` and throws in the app dir). Rejected alternative: `window.location.reload()`
// / a full `window.location.href` navigation (the new-job-form.tsx precedent) — it works
// but is a heavier UX (full document load, visible flash) and the ticket said "router
// refresh". Trivially reversible if the Reviewer prefers otherwise (§5 Q1).
//
// refresh() fires ONLY on 200 — never on a non-200 or a throw: a failed transition must
// leave the locked screen and its `role="alert"` intact, not silently re-render.
//
// Single-flight via an `inFlight` ref so a double-click issues ONE request (a disabled
// button is not a guarantee — both clicks can dispatch before React re-renders). On the
// 200 path it returns BEFORE the `finally` clears `inFlight`/`busy`, but `done` keeps the
// button disabled through the brief refresh window so a click cannot issue a second PATCH
// (plan R2); in production the component unmounts when the refreshed page renders the
// unlocked branch. On the failure paths the `finally` clears the guards so the button
// stays usable.
//
// Non-200/throw: an inline `role="alert"` message (FIT-01's contract), button stays usable.
// NO `console.*` — a job's status change is tied to the user's private application activity
// (plan S3; mark-applied-button pins the absence and so must this).

const DANGER = '#b00020';

export default function StatusTransitionButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function markInterviewing() {
    if (inFlight.current || done) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // EXACTLY this body — one key — per acceptance item 2.
        body: JSON.stringify({ status: 'interviewing' }),
      });
      if (res.status === 200) {
        setDone(true); // keeps the button disabled (via `disabled={busy || done}`) through the refresh window.
        router.refresh(); // re-run the server tree: page.tsx's unlocked branch + layout's unlocked tab link.
        return; // deliberately do NOT clear inFlight/busy here — `done` keeps the button disabled (plan R2).
      }
      setError(messageFor(res.status));
    } catch {
      setError('We could not reach the server. Try again.');
    } finally {
      // Cleared on the FAILURE paths so the button stays usable; on success `done` keeps it disabled.
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div style={{ margin: '1.5rem 0 0' }}>
      {error ? (
        <p role="alert" style={{ color: DANGER }}>
          {error}
        </p>
      ) : null}
      {done ? <p role="status">Unlocking your prep…</p> : null}
      <button type="button" onClick={() => void markInterviewing()} disabled={busy || done}>
        I got the interview
      </button>
    </div>
  );
}

/** FIT-01's PATCH contract, branch by branch. No raw server value is echoed. */
function messageFor(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again to continue.';
  if (status === 404) return 'We could not find that job.';
  return 'We could not update this job. Try again.';
}
