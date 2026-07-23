'use client';

import { useRef, useState } from 'react';

// TLR-02 Deliverable 5 (plan §3.12 / D5) — the manual "Mark as applied" trigger.
// 04-fit/README.md's decision: `job.status → 'applied'` is a manual, TLR-02-owned action
// calling FIT-01's existing generic status route — NO new API route.
//
// Calls `PATCH /api/jobs/[id]` with EXACTLY `{ status: 'applied' }` (acceptance item 4).
// Single-flight via an `inFlight` ref so a double-click issues ONE request (a disabled
// button is not a guarantee — both clicks can dispatch before React re-renders).
//
// On 200 (D5): confirm IN PLACE — show "Marked as applied" and disable the button. It does
// NOT reload: the StatusChip lives in FIT-03's server-rendered layout, which this ticket
// may not edit, so the chip updates on the user's next navigation (documented staleness,
// plan R5). A reload was rejected — awkward to assert and re-runs the whole detail render.
//
// Non-200/throw: an inline `role="alert"` message (FIT-01's contract), button stays usable.
// NO `console.*` — a job's status change is tied to the user's private application activity.

const DANGER = '#b00020';

export default function MarkAppliedButton({ jobId }: { jobId: string }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function markApplied() {
    if (inFlight.current || done) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // EXACTLY this body — one key — per acceptance item 4.
        body: JSON.stringify({ status: 'applied' }),
      });
      if (res.status === 200) {
        setDone(true);
        return;
      }
      setError(messageFor(res.status));
    } catch {
      setError('We could not reach the server. Try again.');
    } finally {
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
      {done ? <p role="status">Marked as applied</p> : null}
      <button type="button" onClick={() => void markApplied()} disabled={busy || done}>
        Mark as applied
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
