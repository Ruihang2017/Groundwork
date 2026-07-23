'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { z } from 'zod';

import ResumeWorkspace from '@/app/(app)/jobs/[id]/resume/_components/resume-workspace';
import { toDroppedItems } from '@/app/(app)/jobs/[id]/resume/_lib/dropped-view';
import { TailoredResume } from '@/lib/schemas/persisted';
import { Edit } from '@/lib/schemas/pipeline';

// TLR-02 Deliverable 7's "Generate tailored resume" trigger (plan §3.13 / D4). Shown by
// page.tsx when no TailoredResume exists yet.
//
// D4 — CLICK-TRIGGERED, NOT AUTO-ON-MOUNT (unlike FIT-03's auto-runner). PRD §5.1's TAILOR
// trigger is "用户决定投", and every call charges a `tailor` quota unit (5/day), so
// generation must be a deliberate act. The single-flight `inFlight` ref guards double
// CLICKS (StrictMode's dev double-mount is irrelevant — nothing fires on mount).
//
// The 200 body is validated defensively before anything renders (defence in depth; the
// server is the real boundary). The response schema is MODULE-LOCAL (breakdown-plan §3),
// composing PURE schemas (`TailoredResume`, `Edit`) so nothing DB-touching enters the
// client bundle — a value import of `@/lib/db/queries/*` would drag drizzle in (plan R10).
// On parse failure → the generic error state, never a half-rendered draft.
//
// Error branches key on the `error` STRING (TLR-01 returns two distinct 409s), each an
// actionable `role="alert"` message; the button stays usable. The raw `resetAt` epoch is
// never echoed. NO `console.*`; the response is held in component state only (PRD §8.1).

const TailorRunResponse = TailoredResume.extend({
  // Absent-tolerant: `dropped` exists only in the fresh 200 body (TLR-01 does not persist it).
  dropped: z
    .object({
      count: z.number(),
      edits: z.array(z.object({ item: Edit, reason: z.string() })),
      numbers: z.array(z.object({ token: z.string(), reason: z.string() })),
    })
    .optional(),
});
type TailorRunResponse = z.infer<typeof TailorRunResponse>;

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; parsed: TailorRunResponse }
  | { kind: 'error'; message: string; libraryLink?: boolean; fitLink?: boolean };

const DANGER = '#b00020';
const GENERIC = 'We could not produce a tailored draft. Try again.';

export default function TailorGenerator({
  jobId,
  projectNames,
}: {
  jobId: string;
  projectNames: Record<string, string>;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const inFlight = useRef(false);

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: 'running' });
    try {
      // NO body, NO Content-Type — TLR-01's route reads none.
      const res = await fetch(`/api/jobs/${jobId}/tailor`, { method: 'POST' });
      const body = await readJson(res);

      if (res.status === 200) {
        const parsed = TailorRunResponse.safeParse(body);
        if (!parsed.success) {
          setState({ kind: 'error', message: GENERIC });
          return;
        }
        setState({ kind: 'done', parsed: parsed.data });
        return;
      }

      setState(failureFor(res.status, errorOf(body)));
    } catch {
      setState({ kind: 'error', message: 'We could not reach the server. Try again.' });
    } finally {
      inFlight.current = false;
    }
  }

  if (state.kind === 'done') {
    const { parsed } = state;
    return (
      <ResumeWorkspace
        jobId={jobId}
        // The extra `dropped` key is harmless — ResumeWorkspace reads only TailoredResume fields.
        tailored={parsed}
        projectNames={projectNames}
        droppedItems={toDroppedItems(parsed.dropped)}
        droppedCount={parsed.dropped?.count ?? 0}
      />
    );
  }

  return (
    <section>
      <h2 style={{ fontSize: '1.1rem', margin: '0 0 0.5rem' }}>Tailor your resume</h2>
      <p style={{ margin: '0 0 1rem' }}>
        Generate a keyword alignment table, per-edit rewrite suggestions, and a full draft
        you can edit and print.
      </p>

      {state.kind === 'error' ? (
        <>
          <p role="alert" style={{ color: DANGER }}>
            {state.message}
          </p>
          {state.libraryLink ? (
            <p>
              <Link href="/library">Import your resume</Link>
            </p>
          ) : null}
          {state.fitLink ? (
            <p>
              <Link href={`/jobs/${jobId}`}>Go to the Fit report</Link>
            </p>
          ) : null}
        </>
      ) : null}

      {state.kind === 'running' ? (
        <p role="status">Tailoring your resume… this usually takes about 30 seconds.</p>
      ) : null}

      <p>
        <button type="button" onClick={() => void run()} disabled={state.kind === 'running'}>
          Generate tailored resume
        </button>
      </p>
    </section>
  );
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorOf(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : null;
}

/** TLR-01's wire contract, branch by branch. Branch on the `error` STRING, not the status. */
function failureFor(status: number, error: string | null): State {
  if (status === 401) {
    return { kind: 'error', message: 'Your session has expired. Sign in again to continue.' };
  }
  if (status === 404) {
    return { kind: 'error', message: 'We could not find that job.' };
  }
  if (status === 409 && error === 'fit_not_ready') {
    return {
      kind: 'error',
      message: 'Run the Fit report for this job first, then come back to tailor your resume.',
      fitLink: true,
    };
  }
  if (status === 409 && error === 'no_library') {
    return {
      kind: 'error',
      message: 'Your library is empty, so there is nothing to tailor from.',
      libraryLink: true,
    };
  }
  if (status === 429) {
    // `resetAt` is a raw epoch number and is deliberately NOT echoed.
    return { kind: 'error', message: "You've used today's tailor allowance. Try again tomorrow." };
  }
  if (status === 422) {
    return { kind: 'error', message: GENERIC };
  }
  if (status === 503) {
    return { kind: 'error', message: 'Tailoring is temporarily unavailable. Try again later.' };
  }
  return { kind: 'error', message: GENERIC };
}
