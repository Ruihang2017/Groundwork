'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import FitReportView from '@/app/(app)/jobs/[id]/_components/fit-report-view';
import {
  droppedFromLedger,
  droppedFromResponse,
  type DroppedView,
} from '@/app/(app)/jobs/[id]/_components/fit-view-model';
import { FitReport, JdExtract, Ledger } from '@/lib/schemas/pipeline';

// FIT-03 Deliverable 7 — the concrete UI realisation of the "single Fit action".
//
// PLAN D3 / 04-fit/README.md decision-table row 1: "Fit" is ONE user-facing operation
// delivered as TWO server calls. The user pastes a JD once; `POST /api/jobs` (FIT-01)
// creates the row and charges the `fit` quota, the browser navigates to /jobs/<id>,
// and THIS component issues the second call — `POST /api/jobs/<id>/fit` (FIT-02) —
// automatically on mount when the job has no `fit` yet. PRD §4 S2: "全选粘贴 JD →
// 30s 内拿到 Fit Report".
//
// PLAN D4 — THE REPORT IS RENDERED FROM THE RESPONSE BODY, NOT FROM A REFETCH. No
// `router.refresh()`, no `useRouter`. That is not a testing convenience: FIT-02's
// `dropped` payload EXISTS ONLY IN THAT RESPONSE and is never persisted (its own
// header says so). A refresh would re-read from the database and LOSE exactly the data
// PRD §5.5 layer 1 requires the front end to show ("dropped 计数随响应返回，前端可查看
// 被弃原始条目"). Rendering from the response is the only way to satisfy it at all.
//
// PLAN D9 — SINGLE-FLIGHT, AND NO AUTOMATIC RETRY. A `useRef` guard means one mounted
// component issues AT MOST ONE automatic POST for its lifetime, including under React
// StrictMode's dev double-mount (next.config.mjs is empty, so `reactStrictMode` takes
// its Next 15 default of TRUE — this guard is load-bearing in dev, not decorative).
// There is deliberately NO retry, NO backoff and NO debounce: a failure renders an
// error plus a MANUAL "Try again" button, because an automatic retry would be a second
// PAID CROSS call issued from a component the user may not even be watching.
//
// ⚠️ WHAT THE REF GUARD DOES NOT AND CANNOT FIX (plan R6 / §5 Q4, and the ticket's
// Feedback obligation #1 forbids papering over it): two TABS, or a fast
// back-and-forward, can each mount a fresh runner and both POST. FIT-02's
// `already_fitted` guard turns the loser into a 409 in the common case, but FIT-02's
// own header documents the residual race where both read `fit === null` and BOTH PAY.
// And a user who closes the tab mid-call leaves the job `fit`-less forever, having
// already spent the quota unit. Neither is fixable from this file — closing them needs
// a claim column or an advisory lock in db/schema.ts (FND-05's file-scope) and
// Horace's sign-off. They are REPORTED to 04-fit/README.md's open questions, not
// silenced with client-side debouncing.
//
// PLAN D10 — 409 already_fitted IS NOT AN ERROR STATE. It means another tab or request
// already produced the report; the user's Fit EXISTS and must be shown. Showing "something
// went wrong" while the report sits in the database would be a false failure. The
// recovery `GET` renders it with `partial: true` dropped data (D8). Note the branch is
// on the `error` STRING and not the status code — FIT-02 returns TWO different 409s and
// its header mandates this.
//
// PRD §5.1's "全程 streaming 展示进度" IS NOT SATISFIED here (plan §5 Q5, owner Horace):
// FIT-02's route returns one JSON body, and adding a progress stream is a route-shape
// change outside this ticket's file-scope. The honest substitute is a `role="status"`
// line carrying §5.1's real p50 expectation. LIB-03 recorded the same shortfall for
// PARSE, where PRD did NOT name streaming; here PRD DOES, so this is a genuine gap.
//
// NO `console.*`: the response carries the user's JD-derived ledger and their library
// evidence. NO localStorage/sessionStorage/IndexedDB/cookie persistence of any response
// content and nothing in a URL or query string (PRD §8.1). Tests pin both.

/**
 * The response contract, validated before anything renders. Module-local by
 * breakdown-plan.md §3 ("任何模块新增的 Zod 类型必须落在自己模块目录下").
 *
 * It composes `@/lib/schemas/pipeline` (pure Zod) rather than `PersistedJob` from
 * `@/lib/db/queries/jobs` — a VALUE import of that module would drag `drizzle-orm` and
 * `@/db/schema` into the client bundle (plan E12).
 *
 * Defence in depth, exactly as library/_lib/api.ts validates its own responses: the
 * server is the real trust boundary, and a parse failure renders the ERROR state
 * rather than a half-drawn report.
 */
const FitRunResponse = z.object({
  jd: JdExtract,
  ledger: Ledger,
  fit: FitReport,
  dropped: z
    .object({
      count: z.number(),
      bindings: z.array(
        z.object({
          item: z.object({
            requirementId: z.string(),
            projectId: z.string(),
            strength: z.enum(['strong', 'partial']),
            evidence: z.string(),
          }),
          reason: z.string(),
        }),
      ),
      uncoveredRequirementIds: z.array(z.string()),
    })
    // Absent on the GET /api/jobs/{id} recovery path (D10).
    .optional(),
});

type Report = {
  jd: z.infer<typeof JdExtract>;
  ledger: z.infer<typeof Ledger>;
  fit: z.infer<typeof FitReport>;
  dropped: DroppedView;
};

type State =
  | { kind: 'running' }
  | { kind: 'done'; report: Report }
  | { kind: 'error'; message: string; libraryLink?: boolean };

const GENERIC_ERROR = 'We could not produce your Fit Report. Nothing was charged twice — try again.';
const DANGER = '#b00020';

export default function FitAutoRunner({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: 'running' });
  // D9's guard: one AUTOMATIC POST per mounted component, StrictMode included.
  const autoStarted = useRef(false);
  // Guards the manual "Try again" button against a double-click issuing two paid calls
  // before React re-renders and disables it.
  const inFlight = useRef(false);

  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    void run();
    // Intentionally mount-only: re-running on any dependency change would be a second
    // paid call. `run` is stable enough for this single use and is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: 'running' });

    try {
      // NO body and NO Content-Type: FIT-02's route reads none at all.
      const res = await fetch(`/api/jobs/${jobId}/fit`, { method: 'POST' });
      const body = await readJson(res);

      if (res.status === 200) {
        finish(body);
        return;
      }

      // D10 — branch on the ERROR STRING, not the status code: FIT-02 returns two
      // distinct 409s and only one of them is a failure.
      if (res.status === 409 && errorOf(body) === 'already_fitted') {
        await recover();
        return;
      }

      setState(failureFor(res.status, errorOf(body)));
    } catch {
      setState({ kind: 'error', message: 'We could not reach the server. Try again.' });
    } finally {
      inFlight.current = false;
    }
  }

  /** D10: the Fit already exists — read it and show it, with D8's partial dropped view. */
  async function recover() {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (res.status !== 200) {
      setState(failureFor(res.status, errorOf(await readJson(res))));
      return;
    }
    finish(await readJson(res));
  }

  function finish(body: unknown) {
    const parsed = FitRunResponse.safeParse(body);
    if (!parsed.success) {
      // Never a half-rendered report.
      setState({ kind: 'error', message: GENERIC_ERROR });
      return;
    }
    const { jd, ledger, fit, dropped } = parsed.data;
    setState({
      kind: 'done',
      report: {
        jd,
        ledger,
        fit,
        // D8: the full picture when we have the payload, the recoverable half when we
        // do not — and the difference is stated on screen, never silently absorbed.
        dropped: dropped ? droppedFromResponse(dropped, jd) : droppedFromLedger(ledger, jd),
      },
    });
  }

  if (state.kind === 'done') {
    const { jd, ledger, fit, dropped } = state.report;
    return <FitReportView jd={jd} ledger={ledger} fit={fit} dropped={dropped} />;
  }

  if (state.kind === 'error') {
    return (
      <section>
        <p role="alert" style={{ color: DANGER }}>
          {state.message}
        </p>
        {state.libraryLink ? (
          <p>
            <Link href="/library">Import your resume</Link>
          </p>
        ) : null}
        <p>
          <button type="button" onClick={() => void run()}>
            Try again
          </button>
        </p>
      </section>
    );
  }

  return (
    <p role="status">
      Generating your Fit Report… this usually takes about 30 seconds.
    </p>
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

/** FIT-02's wire contract, branch by branch. No raw server value is ever echoed. */
function failureFor(status: number, error: string | null): State {
  if (status === 401) {
    return { kind: 'error', message: 'Your session has expired. Sign in again to continue.' };
  }
  if (status === 404) {
    return { kind: 'error', message: 'We could not find that job.' };
  }
  if (status === 409 && error === 'no_library') {
    return {
      kind: 'error',
      message: 'Your library is empty, so there is nothing to screen this job against.',
      libraryLink: true,
    };
  }
  if (status === 422) {
    return { kind: 'error', message: 'We could not finish screening this job. Try again.' };
  }
  if (status === 503) {
    return { kind: 'error', message: 'Job screening is temporarily unavailable. Try again later.' };
  }
  return { kind: 'error', message: GENERIC_ERROR };
}
