'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import BriefView from '@/app/(app)/jobs/[id]/prep/_components/brief-view';
import { type DroppedItem } from '@/app/(app)/jobs/[id]/prep/_components/dropped-count-header';
import { Brief } from '@/lib/schemas/persisted';
import { Intel, Rehearse, RehearseQuestion, type Ledger } from '@/lib/schemas/pipeline';

// PRP-04 Deliverable 7 (plan §2.3) — the RESEARCH → REHEARSE orchestrator, shown by
// prep/page.tsx when no `Brief` exists yet. Modelled on 04-fit/fit-auto-runner.tsx
// (auto-fire on mount, single-flight, render-from-response, manual retry, no-storage,
// no-logging) but with a TWO-CALL sequence.
//
// D1 — GENERATION AUTO-FIRES ON MOUNT (one automatic RESEARCH→REHEARSE sequence per mount),
// NOT a click-to-generate button: acceptance item 1 says "on render", and PRD §5.1's RESEARCH
// trigger is "进入 Prep" — entering the unlocked tab IS the trigger (the deliberate act was
// PRP-03's "I got the interview" click). Mirrors fit-auto-runner. KNOWN COST LIMITATION
// (plan R3): no Brief is persisted until REHEARSE succeeds, so a persistently-failing
// generation re-fires (and RESEARCH re-charges the `prep` unit) on each fresh unlocked visit,
// bounded by 3/day → 429. Escalate to Horace (README open question) if dogfood shows pain —
// do NOT silently switch to click, which would break item 1's "on render".
//
// D2 — ORCHESTRATION = RESEARCH first, then REHEARSE, with a sharp degrade-vs-hard-fail split.
// RESEARCH 200 (whether failed:false or failed:true, and even if the 200 body fails to parse)
// → capture `intel` (an Intel or null) and PROCEED to REHEARSE (PRD §2 P3 "degrade, don't
// block"). RESEARCH NON-200 → STOP, show the error, do NOT call REHEARSE. The cost hole this
// closes: RESEARCH charges the single `prep` unit for the whole Prep op and REHEARSE charges
// NOTHING (PRP-02), so calling REHEARSE after a RESEARCH 429 would mint a paid brief for a user
// with no quota left, bypassing the one gate. A malformed RESEARCH 200 → treat as degraded
// (intel: null) and proceed (maximal degrade-not-block).
//
// D3 — on REHEARSE 200, render the brief FROM THE RESPONSE BODY (no router.refresh). The
// `dropped` count exists ONLY in PRP-02's immediate response and is never persisted; a refresh
// would re-read via getBrief and LOSE exactly the data PRD §5.5 layer 1 / §5.7 requires. This
// is the only render that can satisfy §5.7's dropped-count in full — hence the render-once
// limitation (Deliverable 6): a later visit to an already-generated Brief cannot show it.
//
// D4 — THE LOAD-BEARING READ. The REHEARSE-200 response schema uses a RELAXED `rehearse`
// (questions .max(5), NOT .length(5)): referential integrity can legitimately drop a
// hallucinated-projectId question, so a VALID persisted brief may carry 0–5 questions
// (PRP-02 D5 / ADR-A). Parsing against strict Brief.length(5) would turn a SUCCESSFUL
// 4-question generation into a false "we could not produce your brief". Composed module-locally
// from PURE schemas (breakdown-plan §3), exactly as briefs.ts defines PersistedRehearse.
//
// D5 — "Try again" after a REHEARSE-phase failure re-runs REHEARSE ONLY, reusing the `intel`
// captured from the already-successful RESEARCH (held in `intelRef`); "Try again" after a
// RESEARCH-phase failure re-runs the whole sequence. RESEARCH spent the `prep` unit + real
// search money; REHEARSE is free — re-running RESEARCH because the FREE half failed would waste
// a second `prep` unit.
//
// D6 — SINGLE-FLIGHT, NO AUTOMATIC RETRY. `autoStarted` guards the mount effect (one
// auto-sequence per mount, StrictMode double-mount included — next.config.mjs is empty so
// reactStrictMode defaults TRUE). `inFlight` guards each entry point. A failure renders a
// manual "Try again" button and then WAITS: an auto-retry loop on a degrading route would be
// unbounded paid calls from a component the user may not be watching.
//
// D13 — PROGRESS UI is a two-phase role="status" line. PRD §5.1 names "全程 streaming 展示进度"
// but the routes each return one JSON body — streaming is NOT implemented (the same gap
// fit-auto-runner records for Fit). A two-phase status line is the honest substitute across the
// long RESEARCH+REHEARSE sequence (PRD "Prep ≤ 90s" p50). Flagged, not hidden.
//
// NO `console.*`: the response carries the user's company intel + project-anchored questions
// (PRD §8.1). NO localStorage/sessionStorage/cookie/URL persistence of any response content.
// Both pinned by tests.

// D4 — the relaxed rehearse (questions .max(5), not .length(5)). See the D4 note above.
const PersistedRehearse = Rehearse.extend({
  questions: z.array(RehearseQuestion).max(5),
});

/**
 * PRP-02's 200 body: the persisted Brief at the top level plus the additive `dropped` key,
 * which exists ONLY here (never persisted — D3). Composes PURE `@/lib/schemas/**` so nothing
 * DB-touching (drizzle) enters the client bundle (plan R7); a value import of
 * `@/lib/db/queries/*` would drag it in.
 */
const RehearseResponse = Brief.extend({
  rehearse: PersistedRehearse,
  dropped: z
    .object({
      count: z.number(),
      questions: z.array(z.object({ item: RehearseQuestion, reason: z.string() })),
    })
    .optional(),
});
type RehearseResponse = z.infer<typeof RehearseResponse>;

/** PRP-01's 200 body. */
const ResearchResponse = z.object({ intel: Intel.nullable(), failed: z.boolean() });

type State =
  | { kind: 'researching' }
  | { kind: 'rehearsing' }
  | { kind: 'done'; brief: RehearseResponse }
  | {
      kind: 'error';
      phase: 'research' | 'rehearse';
      message: string;
      libraryLink?: boolean;
      fitLink?: boolean;
    };

const DANGER = '#b00020';
const GENERIC = 'We could not prepare your interview brief. Try again.';
const NETWORK = 'We could not reach the server. Try again.';

export default function BriefGenerator({
  jobId,
  ledger,
  projectNames,
}: {
  jobId: string;
  ledger: Ledger | null;
  projectNames: Record<string, string>;
}) {
  const [state, setState] = useState<State>({ kind: 'researching' });
  // D6's guard: one AUTOMATIC sequence per mounted component, StrictMode included.
  const autoStarted = useRef(false);
  // Guards each entry point against a double-invocation before React re-renders.
  const inFlight = useRef(false);
  // D5: the RESEARCH result, held across a rehearse-phase retry. `undefined` = RESEARCH has
  // not yet succeeded.
  const intelRef = useRef<Intel | null | undefined>(undefined);

  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    void startFull();
    // Intentionally mount-only: re-running on any dependency change would be a second paid
    // sequence. The functions are stable enough for this single use and are not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** RESEARCH phase (D2). Returns the captured intel on 200, or a failure signal on non-200. */
  async function performResearch(): Promise<{ ok: true; intel: Intel | null } | { ok: false }> {
    setState({ kind: 'researching' });
    try {
      // NO body and NO Content-Type: PRP-01's route reads none at all.
      const res = await fetch(`/api/jobs/${jobId}/research`, { method: 'POST' });
      const body = await readJson(res);

      if (res.status !== 200) {
        // D2 — a non-200 RESEARCH is a HARD STOP; REHEARSE is never reached.
        setState(failureFor('research', res.status, errorOf(body)));
        return { ok: false };
      }

      // D2 — a malformed 200 body degrades to intel: null rather than blocking the brief.
      const parsed = ResearchResponse.safeParse(body);
      const intel = parsed.success ? parsed.data.intel : null;
      intelRef.current = intel;
      return { ok: true, intel };
    } catch {
      setState({ kind: 'error', phase: 'research', message: NETWORK });
      return { ok: false };
    }
  }

  /** REHEARSE phase (D2/D3/D4). Renders the brief from the 200 body, or an error. */
  async function performRehearse(intel: Intel | null): Promise<void> {
    setState({ kind: 'rehearsing' });
    try {
      const res = await fetch(`/api/jobs/${jobId}/rehearse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The `intel` KEY must be present (may be null) — PRP-02's BodySchema requires it.
        body: JSON.stringify({ intel }),
      });
      const body = await readJson(res);

      if (res.status !== 200) {
        setState(failureFor('rehearse', res.status, errorOf(body)));
        return;
      }

      const parsed = RehearseResponse.safeParse(body);
      if (!parsed.success) {
        // Never a half-rendered brief (D3).
        setState({ kind: 'error', phase: 'rehearse', message: GENERIC });
        return;
      }
      setState({ kind: 'done', brief: parsed.data });
    } catch {
      setState({ kind: 'error', phase: 'rehearse', message: NETWORK });
    }
  }

  /** Entry point: the full RESEARCH→REHEARSE sequence (mount + research-phase retry). */
  async function startFull() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const research = await performResearch();
      if (!research.ok) return; // D2 hard stop — do not call REHEARSE.
      await performRehearse(research.intel);
    } finally {
      inFlight.current = false;
    }
  }

  /** Entry point: REHEARSE only, reusing the captured intel (D5 — rehearse-phase retry). */
  async function retryRehearse() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await performRehearse(intelRef.current ?? null);
    } finally {
      inFlight.current = false;
    }
  }

  if (state.kind === 'done') {
    const { brief } = state;
    return (
      <BriefView
        intel={brief.intel}
        rehearse={brief.rehearse}
        ledger={ledger}
        projectNames={projectNames}
        droppedCount={brief.dropped?.count ?? 0}
        droppedItems={toDroppedItems(brief.dropped)}
      />
    );
  }

  if (state.kind === 'error') {
    const onRetry = state.phase === 'research' ? startFull : retryRehearse;
    return (
      <section>
        <p role="alert" style={{ color: DANGER }}>
          {state.message}
        </p>
        {state.fitLink ? (
          <p>
            <Link href={`/jobs/${jobId}`}>Go to the Fit report</Link>
          </p>
        ) : null}
        {state.libraryLink ? (
          <p>
            <Link href="/library">Import your resume</Link>
          </p>
        ) : null}
        <p>
          <button type="button" onClick={() => void onRetry()}>
            Try again
          </button>
        </p>
      </section>
    );
  }

  return (
    <p role="status">
      {state.kind === 'researching'
        ? 'Researching the company… this is the first of two steps and can take up to about 90 seconds.'
        : 'Preparing your interview questions… almost done.'}
    </p>
  );
}

/** D3 — map PRP-02's response `dropped` payload into the header's items. `undefined` (the
 *  reload path, which never sees `dropped`) maps to an empty list. */
function toDroppedItems(dropped: RehearseResponse['dropped']): DroppedItem[] {
  if (!dropped) return [];
  return dropped.questions.map(({ item, reason }) => ({
    // The question text is the readable anchor; fall back to the project id if it is empty.
    label: item.question === '' ? item.projectId : item.question,
    detail: `Cites "${item.projectId}", which isn't in your library (${reason}).`,
  }));
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

/**
 * PRP-01/PRP-02's wire contracts, branch by branch. Branch on the `error` STRING (both route
 * headers mandate this), never on a raw server value (the `resetAt` epoch is never echoed).
 * `403` should be unreachable — the page already gated `interviewing` — so it falls to the
 * generic message defensively.
 */
function failureFor(phase: 'research' | 'rehearse', status: number, error: string | null): State {
  if (status === 401) {
    return {
      kind: 'error',
      phase,
      message: 'Your session has expired. Sign in again to continue.',
    };
  }
  if (status === 404) {
    return { kind: 'error', phase, message: 'We could not find that job.' };
  }
  if (status === 409 && error === 'fit_not_ready') {
    return {
      kind: 'error',
      phase,
      message: 'Run the Fit report for this job first, then come back to prepare.',
      fitLink: true,
    };
  }
  if (status === 409 && error === 'no_library') {
    return {
      kind: 'error',
      phase,
      message: 'Your library is empty, so there is nothing to prepare from.',
      libraryLink: true,
    };
  }
  if (status === 429) {
    // `resetAt` is a raw epoch number and is deliberately NOT echoed.
    return {
      kind: 'error',
      phase,
      message: "You've used today's prep allowance. Try again tomorrow.",
    };
  }
  if (status === 503) {
    return {
      kind: 'error',
      phase,
      message: 'Interview prep is temporarily unavailable. Try again later.',
    };
  }
  // 422 (rehearse), 500, 403 (unreachable) and anything else → the generic prep-failed message.
  return { kind: 'error', phase, message: GENERIC };
}
