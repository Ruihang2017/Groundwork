# Implementation plan — PRP-03: Prep tab shell (lock/unlock UI)

Ticket: [docs/prd/06-prep/tickets/PRP-03-prep-tab-shell.md](../prd/06-prep/tickets/PRP-03-prep-tab-shell.md)
Sub-PRD: [docs/prd/06-prep/README.md](../prd/06-prep/README.md)
Master spec: [docs/PRD.md](../PRD.md) §5.4 (unlock condition: `job.status = interviewing`, triggered by the user clicking "我拿到面试了"), §5.7 (Job 详情 row: "Fit / Resume / Prep 三段推进；Prep 在 interviewing 前锁定（文案：'拿到面邀后解锁'）"), §5.8 ("UI 英文" — every UI string in English), §8.3 (全部查询以 session userId 约束、无跨用户查询路径)
Upstream tickets whose merged code this builds on: [FIT-01](../prd/04-fit/tickets/FIT-01-job-creation-status-route.md) (`PATCH /api/jobs/[id]`, `getJob`, `PersistedJob`, `lib/db/queries/jobs.ts`), [FIT-03](../prd/04-fit/tickets/FIT-03-jobs-list-fit-report-ui.md) (`app/(app)/jobs/[id]/layout.tsx` — the shared shell this page renders inside; `app/(app)/jobs/[id]/_components/job-tabs.tsx` — the tab nav whose locked Prep `<span>` says "PRP-03 owns the REAL page-level check"), [FND-08](../prd/01-foundation/tickets/FND-08-authjs-session.md) (`requireUserId`, `middleware.ts` allowlist-by-omission gate), [FND-09](../prd/01-foundation/tickets/FND-09-app-shell-deploy.md) (`@testing-library/react` + jsdom test setup)
Cross-ticket analogs (READ THESE before writing — this ticket mirrors them): [TLR-02](../prd/05-tailor/tickets/) `app/(app)/jobs/[id]/resume/_components/mark-applied-button.tsx` (a status-transition button calling the same generic PATCH — the near-exact structural template) and its `.test.tsx`; `app/(app)/jobs/[id]/resume/page.tsx` and the Fit tab `app/(app)/jobs/[id]/page.tsx` (the tab-page server-component template).
ADRs: `docs/adr/` holds only `.gitkeep` — none exist. This plan raises **no** ADR candidate (§6 says why). Do **not** create any ADR file.
Base commit: `346307d` on `main` (`merge: [PRP-02] ticket/PRP-02 -> main (pipeline CLEAR)`), working tree clean at planning time (2026-07-24). Branch per repo convention: `ticket/PRP-03`.

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone. Every "verified" claim below was checked by direct inspection at planning time — confirm cheaply if you like, do not re-derive.

**Standing environment rules on this machine** (carried from prior plans, re-verified this session):

- Invoke pnpm as **`corepack pnpm ...`** — bare `pnpm` is not on the Bash tool's `PATH`.
- Every Bash invocation prints a harmless first line `/c/Users/HoraceHou/.bash_profile: line 1: $'\377\376source': command not found`. That is the user's UTF-16-BOM'd `~/.bash_profile`, **not** a repo file. Ignore it.
- `.gitattributes` is `* text=auto eol=lf` — new files are materialized LF. Do not add CRLF.
- Paths in this repo contain `(app)` and `[id]` segments. In Bash, **quote every such path** (`"app/(app)/jobs/[id]/prep/page.tsx"`), or globbing/grouping mangles it.

---

## 0. Repo-state check performed for this plan (verified 2026-07-24 at `346307d`)

**Baseline `corepack pnpm test`: the last recorded green run is 80 files / 1087 tests** (06-prep/README.md v0.3, PRP-02 Builder writeback). Confirm this by running it once before you start; your final run must be ≥ these counts and still green. (Not re-run at planning time — the full suite is slow; the count is the documented baseline, not a guess about behavior.)

### 0.0 Facts verified by direct inspection (do not re-litigate — each costs a bounce if guessed wrong)

- **The `prep/` route does not exist yet.** `app/(app)/jobs/[id]/` currently holds `layout.tsx`, `page.tsx` (Fit tab), `_components/**`, and `resume/**` (TLR-02). There is **no `prep/`** directory. This ticket creates it. (Glob-confirmed.)
- **The shared shell is already built and MUST NOT be touched** — `app/(app)/jobs/[id]/layout.tsx` (FIT-03) reads `getJob`, guards existence+ownership with `notFound()`, renders the header + `<StatusChip>` + `<JobTabs>` + `{children}`. Its header comment states the contract this ticket depends on: *"06-prep add their pages under `[id]/prep/**` … They must NOT edit this file."* Your `page.tsx` renders as `{children}` inside it.
- **`job-tabs.tsx` (FIT-03) already handles the tab-nav lock** and points here: when `status !== 'interviewing'` it renders a non-navigable `<span>Prep</span> <small>(Unlocked after you get an interview invite)</small>`; when `'interviewing'` it renders a real `<Link href={`/jobs/${jobId}/prep`}>`. Its header says verbatim: *"⚠️ THIS LOCK IS A UX HINT, NOT AN ENFORCEMENT BOUNDARY. Typing /jobs/<id>/prep bypasses it entirely … PRP-03 owns the REAL page-level check at app/(app)/jobs/[id]/prep/page.tsx. Nobody may later delete PRP-03's own check on the grounds that 'the tab is already locked'."* **Your `page.tsx`'s `status !== 'interviewing'` branch IS that page-level check.** It exports `PREP_LOCKED_COPY = 'Unlocked after you get an interview invite'` — see §2 on why this ticket does **not** import it.
- **`PATCH /api/jobs/[id]` (FIT-01) is the transition route** — the button's only server surface. Its header WIRE CONTRACT, transcribed so you code against it verbatim:
  - `PATCH /api/jobs/{id}`, `Content-Type: application/json`, body `{ "status": "screening"|"applied"|"interviewing"|"closed" }`.
  - `200 <the updated job>` (`Cache-Control: no-store`) · `400 {error:'invalid_body', issues:string[]}` · `401 {error:'Unauthorized'}` · `404 {error:'not_found'}` (also when it is another user's job) · `500 {error:'job_write_failed'}`.
  - It is **PERMISSIVE by design**: any enum value from any current status, including `screening → interviewing` directly (no state-machine ordering). Enum validity is the whole body rule; `z.object` strips unknown keys. Ownership is enforced inside a single `UPDATE … WHERE id=? AND user_id=? RETURNING` (session `userId`, PRD §8.3) — a non-owner gets a byte-identical `404`.
  - **This ticket adds no new API route and no server-side change.** It only *calls* this existing, already-reviewed route (ticket Non-goals).
- **`getJob(userId, jobId): Promise<PersistedJob | null>` (`lib/db/queries/jobs.ts`, FIT-01)** — `null` when absent **or** another user's (indistinguishable by design). **Throws** on stored-row drift (loud-failure policy). The module is import-safe with `DATABASE_URL` unset (memoized lazy `dbIndex()`), so `page.tsx` may import it **statically**, exactly as the Fit tab and resume pages do — a build-guard test pins this.
- **`PersistedJob.status` type** is `JobStatus = 'screening'|'applied'|'interviewing'|'closed'` (FND-04). "Not interviewing" = `screening | applied | closed`.
- **The near-exact template — `mark-applied-button.tsx` (TLR-02)**: a `'use client'` button that `PATCH`es `/api/jobs/<id>` with `{ status: 'applied' }`, single-flight via a `useRef(false)` `inFlight` guard, `done`/`busy` state gating `disabled`, a `messageFor(status)` helper (401 → session-expired, 404 → not-found, else generic), an inline `role="alert"` on failure, and **no `console.*`** (a status change is private application activity — pinned by a test). Your button is this component with two deltas (§2.3): body `{ status: 'interviewing' }`, and on-200 it calls a router refresh instead of confirming in place.
- **No `useRouter` / `router.refresh()` anywhere in the repo yet.** `new-job-form.tsx` full-navigates (`window.location.href`), `mark-applied-button.tsx` confirms in place, `fit-auto-runner.tsx` deliberately avoids the router, `library-workspace.tsx` states "NO `useRouter`, NO `router.refresh()`". The only `next/navigation` imports today are `notFound` (server pages) and it is always mocked in tests. **This ticket introduces the repo's first `useRouter().refresh()`** — see the decision + test-mock requirement in §2.3 and R3.
- **Test harness**: `vitest.config.ts` `include` already covers `app/**/*.test.{ts,tsx}` — **no config change**, new test files are auto-discovered. Global `environment: 'node'`; component tests opt into jsdom with a **file-top `// @vitest-environment jsdom`** comment. `hookTimeout` is a 30 000 ms global floor. **There is NO `vitest.setup.ts` / `setupFiles`** — jest-dom matchers are **not** available. Assert with raw `@testing-library` primitives: `screen.getByRole(...)`, `queryByRole(...) === null`, `.toBeTruthy()`, `(btn as HTMLButtonElement).disabled`, `.textContent`. **Do not write `.toBeInTheDocument()`** — it will not compile.
- **`package.json` needs NO change** — no new dependency (`useRouter` is part of `next`). **`tsconfig`/`eslint`/`next.config` unchanged.**
- **ESLint** = `next/core-web-vitals` + `next/typescript`. Import ordering **is enforced**: external-package imports first (alphabetized: e.g. `next/navigation` before `react`), a blank line, then `@/…` imports (alphabetized: `@/app/…` before `@/lib/…`), a blank line, then the header comment. A `'use client'` directive is the very first line, then a blank line, then imports. Match the surrounding files exactly or `corepack pnpm lint` bounces.
- **Next 15.5.20 / React 19.2**: a dynamic segment's `params` is a **Promise** and must be `await`ed in `page.tsx` (a non-Promise type type-checks in isolation and fails `next build`'s generated route-type check in CI). `next.config.mjs` is `{}` ⇒ `reactStrictMode` defaults to `true` (dev double-mount) — irrelevant here because the button is **click-triggered, not on-mount** (no `useEffect`, so no double-fire concern; unlike `fit-auto-runner`).
- **Serial-safety**: no `ticket/PRP-03` branch exists; `app/(app)/jobs/[id]/prep/` does not exist. FIT-01/FIT-03 and PRP-01/PRP-02 are merged into `main`. PRP-04 (which extends this same `page.tsx`) has not started. Nothing is in flight against any file this ticket creates. If that has changed at build time, stop and escalate.

---

## 1. Scope

### In scope (this ticket owns every file below; all are new)

- `app/(app)/jobs/[id]/prep/page.tsx` — server component. Reads the job, branches on `job.status`: `!== 'interviewing'` → `<LockScreen>`; `=== 'interviewing'` → a clearly-commented **placeholder** unlocked marker that PRP-04 replaces. Makes **no** RESEARCH/REHEARSE call on either branch.
- `app/(app)/jobs/[id]/prep/_components/lock-screen.tsx` — the locked-state UI: the PRD-intent copy + `<StatusTransitionButton>`.
- `app/(app)/jobs/[id]/prep/_components/status-transition-button.tsx` — `'use client'`; the "I got the interview" button that `PATCH`es `{ status: 'interviewing' }` and, on 200, refreshes so the now-unlocked branch renders.
- Tests (colocated, per repo convention — each component has its own `.test.tsx`):
  - `app/(app)/jobs/[id]/prep/page.test.tsx`
  - `app/(app)/jobs/[id]/prep/_components/lock-screen.test.tsx`
  - `app/(app)/jobs/[id]/prep/_components/status-transition-button.test.tsx`
- **Ticket Changelog writeback** to `docs/prd/06-prep/tickets/PRP-03-prep-tab-shell.md` (Builder writeback, English, matching every prior ticket) recording: the `useRouter().refresh()` decision (§2.3/R3), the lock-screen-owns-its-copy decision (§2.2), any exact-copy/label wording choices (ticket Feedback obligation #1), the deviations list, and the test results. If the Builder refines the lock copy or button label beyond this plan's suggested wording, **also** add a one-line entry to `docs/prd/06-prep/README.md`'s Changelog (Chinese, matching existing entries) per Feedback obligation #1 — that is the only place the sub-PRD is touched, and only if the wording actually changes.

**The end-to-end flow this delivers** (state it in a comment in `page.tsx` so the Reviewer and PRP-04 see the whole picture):

1. A non-`interviewing` job's tab nav (FIT-03's `job-tabs.tsx`) shows Prep as a non-navigable `<span>`, so the only way to reach `/jobs/<id>/prep` is typing the URL. Doing so renders `<LockScreen>` (this page's `status !== 'interviewing'` check — the page-level gate `job-tabs.tsx` promises).
2. The user clicks "I got the interview" → `PATCH /api/jobs/<id>` `{ status: 'interviewing' }` → 200 → `router.refresh()`.
3. The refresh re-runs the server tree: `layout.tsx` re-reads the job and `job-tabs.tsx` now renders Prep as a real `<Link>`; `prep/page.tsx` re-reads the job, sees `interviewing`, and renders the unlocked placeholder (PRP-04 later makes this the real brief).

### Explicitly out of scope — do not implement, even opportunistically

- **No edit to `app/(app)/jobs/[id]/layout.tsx`** (FIT-03) or `job-tabs.tsx` (FIT-03) — this ticket does not touch the shell or the tab nav; FIT-03 already greys out the Prep link from `job.status` (ticket Non-goals). **Do not import `PREP_LOCKED_COPY` from `job-tabs.tsx`** — §2.2 explains why the lock screen owns its own copy.
- **No new API route, no server-side change** — reuse FIT-01's `PATCH /api/jobs/[id]`, call-only.
- **No RESEARCH / REHEARSE call, on either branch** — `app/api/jobs/[id]/research/route.ts` (PRP-01) and `.../rehearse/route.ts` (PRP-02) are called only by PRP-04, which extends this file's **unlocked** branch next. This ticket's unlocked branch is a **pure render with zero fetch**; a test pins that (§3, R5). Do **not** import `lib/db/queries/briefs.ts` (`getBrief`, PRP-02) — that is PRP-04's read.
- **No real interview-brief content** — the unlocked branch is a placeholder marker only; PRP-04 (same file, same lane, sequential) replaces it (ticket Deliverable 3 + PRP-04 Deliverable 7).
- **No `app/(app)/jobs/[id]/prep/_components/*` beyond `lock-screen.tsx` and `status-transition-button.tsx`** — the brief-content components (`intel-card.tsx`, `question-list.tsx`, this module's own `dropped-count-header.tsx`, etc.) are PRP-04's File-scope.
- **No `vitest.config.ts` / `package.json` / `tsconfig.json` / `next.config.mjs` / `eslint.config.mjs` change. No new dependency.**
- **No status-machine ordering logic** — the button only ever sets `interviewing`; the route is permissive by design.
- **No ADR file** (§6).

---

## 2. Change list

Every file carries a header comment in the repo's established style: what it is, which PRD clause forces it, and which decision from this plan it implements. A decision without a comment at its implementation site is a defect in this repo.

### 2.1 `app/(app)/jobs/[id]/prep/page.tsx` — the Prep tab (Deliverable 3)

Model it line-for-line on the Fit tab `app/(app)/jobs/[id]/page.tsx` (server component, static `getJob`, `notFound()` guard, `force-dynamic`).

```ts
import { notFound } from 'next/navigation';

import LockScreen from '@/app/(app)/jobs/[id]/prep/_components/lock-screen';
import { requireUserId } from '@/lib/auth/session';
import { getJob } from '@/lib/db/queries/jobs';

// header comment (see below)

export const dynamic = 'force-dynamic';

export default async function JobPrepPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;                 // Next 15: params is a Promise; await it or `next build` fails in CI.
  const userId = await requireUserId();         // throws UnauthorizedError → propagates (middleware already gated /jobs/*).
  const job = await getJob(userId, id);         // scoped to the session user (PRD §8.3).
  if (!job) notFound();                         // absent OR another user's → identical 404. Outside any try/catch.

  // PRD §5.4/§5.7: Prep is LOCKED until job.status === 'interviewing'.
  if (job.status !== 'interviewing') {
    return <LockScreen jobId={id} />;
  }

  // === UNLOCKED-STATE PLACEHOLDER — PRP-04 REPLACES THIS BLOCK ===
  // PRP-04 wires RESEARCH → REHEARSE + Brief rendering here. PRP-03 makes NO
  // RESEARCH/REHEARSE call, not even here (ticket Non-goals) — keep this a pure
  // render with zero fetch so both "locked branch makes no API calls" and "unlocked
  // placeholder makes no API calls" hold until PRP-04. Per PRP-03 Feedback obligation
  // #2, PRP-04 may restructure this file freely but MUST preserve the locked-state
  // behavior above (regression-test it).
  return (
    <section aria-labelledby="prep-heading">
      <h2 id="prep-heading">Interview prep</h2>
      <p>Your interview brief will appear here.</p>
    </section>
  );
}
```

Header-comment must state, at minimum: this is PRD §5.7's Prep tab, rendered inside FIT-03's `[id]/layout.tsx` shell; the `status !== 'interviewing'` branch is **the page-level lock `job-tabs.tsx` promises** (the tab-nav lock is only a UX hint — typing the URL reaches here, and this check is what actually withholds the unlocked branch); `getJob` is read **again here** independently of the layout (App Router layouts cannot pass data to pages — the same accepted two-read cost FIT-03 documents as D2, and this page genuinely needs `job.status`); `notFound()` throws and stays **outside** any try/catch; `getJob` is **not** wrapped in try/catch (it throws on row drift — a real bug that must surface, not degrade to 404); static `@/lib/db/queries/jobs` import is import-safe with `DATABASE_URL` unset (build-guard test); and the end-to-end flow from §1.

Rationale to record for using `getJob` here (unlike TLR-02's `resume/page.tsx`, which skips it): the resume page reads a *different* entity (`getTailoredResume`) and relies on the layout's guard, but the Prep page's entire branch **is** `job.status`, so it must read the job. Following the Fit tab's precedent (`getJob` + `if (!job) notFound()`) keeps the guard defensive and the module contract testable.

### 2.2 `app/(app)/jobs/[id]/prep/_components/lock-screen.tsx` (Deliverable 1)

A presentational component — **no `'use client'`** (no hooks, no browser API; it renders the client button as a child, exactly as the server Fit page renders the client `FitAutoRunner`). Takes `{ jobId }` to hand to the button.

```ts
import StatusTransitionButton from '@/app/(app)/jobs/[id]/prep/_components/status-transition-button';

// header comment (see below)

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
```

**Why the lock screen owns its own copy and does NOT import `PREP_LOCKED_COPY` from `job-tabs.tsx`** (state this in the header comment): (a) the two strings serve different UI contexts — `job-tabs.tsx`'s is a terse inline tab hint ("Unlocked after you get an interview invite"), this is a full-page locked state with an explanatory sentence + a call-to-action button, and they may legitimately read differently; (b) importing a constant from a **04-fit** component would couple 06-prep to another module's UI internals, exactly the cross-module coupling `docs/prd/breakdown-plan.md` §3's per-module-duplication decision avoids (the same reason PRP-04 builds its own `dropped-count-header.tsx` rather than importing FIT-03's); (c) exporting `PREP_UNLOCK_COPY` here lets the lock-screen test assert the copy without hardcoding a literal that can drift. The exact wording follows the ticket's Deliverable 1 ("Prep unlocks after you get an interview.") — Feedback obligation #1 permits an i18n-tone refinement, logged in `06-prep/README.md`'s changelog if changed.

### 2.3 `app/(app)/jobs/[id]/prep/_components/status-transition-button.tsx` — `'use client'` (Deliverable 2)

This is `mark-applied-button.tsx` (TLR-02) with **two deltas**; keep everything else identical to that proven component so the Reviewer reviews a small diff:

1. Body is **exactly** `{ status: 'interviewing' }` (acceptance item 2), not `{ status: 'applied' }`.
2. On `200`, instead of confirming in place, it **refreshes the route so the server re-renders the now-unlocked branch** (ticket Deliverable 2: "then refreshing the page/route (Next.js router refresh)").

```ts
'use client';

import { useRouter } from 'next/navigation';   // App Router — NOT next/router (that has no .refresh()).
import { useRef, useState } from 'react';

// header comment (see below)

const DANGER = '#b00020';

export default function StatusTransitionButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function markInterviewing() {
    if (inFlight.current || done) return;       // single-flight (a disabled button is not a guarantee).
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'interviewing' }),   // EXACTLY one key — acceptance item 2.
      });
      if (res.status === 200) {
        setDone(true);         // keeps the button disabled (via `disabled={busy || done}`) through the refresh window.
        router.refresh();      // re-run the server tree: page.tsx's unlocked branch + layout's unlocked tab link.
        return;                // deliberately do NOT clear inFlight/busy here — see note below.
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
      {error ? <p role="alert" style={{ color: DANGER }}>{error}</p> : null}
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
```

Notes the header comment must carry:

- **The `router.refresh()` decision (the plan's central call).** The ticket names "Next.js router refresh". `router.refresh()` (App Router) re-fetches the current route's server components in place — re-running `page.tsx`'s branch and `layout.tsx`'s tab nav — **without a full document reload or losing client state**, which is exactly this ticket's need. This is the repo's **first** `useRouter` use (§0.0, R3). **Rejected alternative: `window.location.reload()` / `window.location.href = '/jobs/'+jobId+'/prep'`** (the `new-job-form.tsx` precedent) — it works but is a heavier UX (full document load, visible flash) and the ticket specifically said "router refresh"; recorded so the Reviewer reviews a decision, not an accident.
- **`refresh()` fires only on 200**, never on a non-200 or a throw — a failed transition must leave the locked screen and its `role="alert"` intact, not silently re-render.
- **The success path intentionally departs from `mark-applied-button`'s blanket `finally` reset**: on 200 it returns before clearing `inFlight`/`busy` (the `finally` still runs and clears them, but `done` keeps the button `disabled`), so a click during the brief refresh window cannot issue a second PATCH. In production the component unmounts when the refreshed `page.tsx` renders the unlocked branch, so `done` is transient; in tests (where `router.refresh` is mocked) it is the assertable success signal.
- **No `console.*` anywhere** — a status change is the user's private application activity (FIT-01's logging rule; `mark-applied-button` pins the absence and so must this).
- **Button label** "I got the interview" = PRD §5.4's "我拿到面试了" in English (§5.8); same i18n latitude as the lock copy (Feedback obligation #1).
- `jobId` comes from the server page's awaited `params.id` (the URL path); the server PATCH route re-derives `userId` from the session and scopes the write, so nothing client-supplied can cross users (R2/S1).

---

## 3. Test plan

All three test files are jsdom (`// @vitest-environment jsdom` as the file's first line). No jest-dom matchers (§0.0) — use `screen.getByRole`, `screen.queryByRole(...) === null`, `.toBeTruthy()`, `(el as HTMLButtonElement).disabled`, `.textContent`, and `waitFor`. Every test runs fully offline (no real `fetch`, no DB). Each acceptance item is mapped to its proving test.

### `app/(app)/jobs/[id]/prep/page.test.tsx` (Deliverable 3; acceptance item 1 + the module-level "no RESEARCH/REHEARSE" gate)

Mirror `app/(app)/jobs/[id]/page.test.tsx`'s scaffolding exactly:

```ts
const { mockRequireUserId, mockGetJob, mockNotFound } = vi.hoisted(() => ({
  mockRequireUserId: vi.fn(),
  mockGetJob: vi.fn(),
  mockNotFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),  // real notFound() throws.
}));
vi.mock('@/lib/auth/session', () => ({
  requireUserId: mockRequireUserId,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@/lib/db/queries/jobs', () => ({ getJob: mockGetJob }));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));
```

Render helper: `const { default: JobPrepPage } = await import('@/app/(app)/jobs/[id]/prep/page'); return render(await JobPrepPage({ params: Promise.resolve({ id }) }));`. Build job fixtures inline as minimal `PersistedJob`-shaped literals **or** reuse `jobFixture()` from `@/app/(app)/jobs/_fixtures/job-fixtures.ts` (FIT-03's fixture builder — `jobFixture({ status: 'screening' })`); the fixture import is test-only and already used by the Fit tab test, so it is the lower-risk choice. Stub `fetch` in a `beforeEach`/helper and assert it is **never** called on any render (the page makes no API call; the button only fetches on click).

| # | Test | Acceptance |
|---|---|---|
| 1 | `status: 'screening'` → `<LockScreen>` renders: the "I got the interview" button is present (`getByRole('button', { name: /i got the interview/i })`), the unlocked heading `/interview prep/i` is **absent** (`queryByRole('heading', { name: /interview prep/i })` is `null`). | ✅ item 1 |
| 2 | `status: 'applied'` → same lock-screen assertion (button present, unlocked heading absent). | ✅ item 1 |
| 3 | `status: 'closed'` → lock screen present. Proves the branch is `!== 'interviewing'`, **not** a `screening`-only whitelist (defensive; `closed` is not named in the acceptance list but must lock). | ✅ item 1 (hardening) |
| 4 | `status: 'interviewing'` → the placeholder marker renders: `getByRole('heading', { name: /interview prep/i })` is truthy, and the button `/i got the interview/i` is **absent** (`queryByRole` null). | ✅ item 1 |
| 5 | **NO fetch on any render**: stub `fetch`; render each of the four statuses; after a `setTimeout(20)` flush (as the Fit tab test does) assert `fetch` was never called. Directly proves 06-prep/README.md's module-level `[machine]` item ("`status !== 'interviewing'` … 不触发任何 RESEARCH/REHEARSE 调用") **and** that PRP-03's unlocked placeholder is inert until PRP-04. | module-level gate |
| 6 | reads with the **session** `userId` and the awaited `params.id`: `expect(mockGetJob).toHaveBeenCalledWith(TEST_USER_ID, JOB_ID)` (PRD §8.3). | — |
| 7 | a missing job (`mockGetJob` → `null`) → `JobPrepPage(...)` rejects with `NEXT_NOT_FOUND` and `mockNotFound` called once. | — |
| 8 | a **throwing** `getJob` (drift) propagates (rejects with `/PersistedJob/`); `mockNotFound` **not** called (a drifted row is a 500-class bug, not a 404). | — |
| 9 | an `UnauthorizedError` from `requireUserId` propagates and `getJob` is **not** called. | — |
| 10 | module contract: `expect(mod.dynamic).toBe('force-dynamic')`. | — |
| 11 | **BUILD GUARD**: with `DATABASE_URL` unset (`vi.stubEnv('DATABASE_URL','')`, `vi.resetModules()`, `vi.doUnmock('@/lib/db/queries/jobs')`), `import('@/app/(app)/jobs/[id]/prep/page')` resolves, while `import('@/db/index')` rejects with `/DATABASE_URL/`. Copy the Fit tab test's exact shape. | — |

Note in the file that tests 1–4's assertions about the **unlocked placeholder** are transient: PRP-04 replaces that branch and will update test 4 accordingly; what PRP-04 must keep green are the **locked-branch** tests (1–3) and the button's behavior (below) — PRP-03 Feedback obligation #2.

### `app/(app)/jobs/[id]/prep/_components/lock-screen.test.tsx` (Deliverable 1)

Mock `next/navigation`'s `useRouter` (the lock screen renders the client button, which calls `useRouter()` at module render — without the mock the real hook throws "invariant expected app router to be mounted"; see R3): `vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))`.

1. renders `PREP_UNLOCK_COPY` (import the exported constant; assert `screen.getByText(PREP_UNLOCK_COPY)` truthy) — pins the exact PRD-intent copy.
2. renders the transition button: `getByRole('button', { name: /i got the interview/i })` truthy.

### `app/(app)/jobs/[id]/prep/_components/status-transition-button.test.tsx` (Deliverable 2; acceptance item 2 — the load-bearing test)

Mirror `mark-applied-button.test.tsx` exactly, plus the router-refresh assertions. Mock the router at the top:

```ts
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
```

`afterEach(cleanup)`, `afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); })`. `stubFetch(status, body)` helper as in `mark-applied-button.test.tsx`. `const button = () => screen.getByRole('button', { name: /i got the interview/i });`.

1. **[machine] PATCHes `/api/jobs/<id>` with exactly `{ status: 'interviewing' }` as JSON** — assert `fetchMock` called once; `url === '/api/jobs/job-1'`; `init.method === 'PATCH'`; `init.headers` deep-equals `{ 'Content-Type': 'application/json' }`; `JSON.parse(init.body)` deep-equals `{ status: 'interviewing' }`; and `Object.keys(parsedBody)` deep-equals `['status']` (nothing smuggled in). **This is acceptance item 2.**
2. **[machine] on 200 refreshes the route and disables the button** — after the click, `waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))`; `(button() as HTMLButtonElement).disabled === true`; the `role="status"` "Unlocking…" line is present.
3. **[machine] COST/idempotency: double-click issues exactly ONE fetch** — copy `mark-applied-button.test.tsx`'s pending-promise pattern (a `fetchMock` returning a never-resolved Promise; click twice; assert `toHaveBeenCalledTimes(1)`; then resolve). Proves the single-flight guard.
4. **[machine] 401** → `role="alert"` matches `/session has expired/i`, button usable (`disabled === false`), and **`mockRefresh` NOT called**.
5. **[machine] 404** → alert `/could not find that job/i`, button usable, no refresh.
6. **[machine] 500** → alert `/could not update this job/i`, button usable, no refresh.
7. **[machine] network throw** (`fetch` rejects) → alert `/could not reach the server/i`, no refresh.
8. **[machine] PRIVACY: never logs** — spy on `console.log`/`error`/`warn`; after a failing (500) click and the alert appears, assert none was called (a status change is private application activity).

### Suite-level exit criteria

`corepack pnpm test` green with ≥ 80 files / 1087 tests plus this ticket's additions; `corepack pnpm lint` clean; **`corepack pnpm build` with `DATABASE_URL` unset exits 0** (CI parity — catches the Next-15 async-`params` type error and the lazy/static-import class of bug; verify `/jobs/[id]/prep` appears in the route table).

---

## 4. Risks and edge cases

**Security-sensitive paths (the Reviewer will check these specifically)**

- **S1 — cross-user isolation / IDOR (PRD §8.3).** The button's only server surface is FIT-01's `PATCH /api/jobs/[id]`, which derives `userId` from the session and scopes the write inside a single `UPDATE … WHERE id=? AND user_id=? RETURNING` (a non-owner → byte-identical 404). The `jobId` handed to the button is the URL path segment, already validated by `getJob`'s owner-scoped read in `page.tsx`. **This ticket adds no new auth surface and no new server code** — it reuses an already-reviewed route. Reviewer: confirm no server-side change slipped in and the client never sends `userId`.
- **S2 — the lock is enforced at the page, not just the nav.** `job-tabs.tsx` (FIT-03) is only a UX hint; **this page's `status !== 'interviewing'` branch is the page-level check it promises.** It withholds the *unlocked* branch — which PRP-04 will wire to paid RESEARCH/REHEARSE calls — from any non-`interviewing` job, even when the URL is typed directly. Defense in depth: PRP-01's RESEARCH route independently returns `403 not_interviewing` server-side before spending money (06-prep/README.md decision). Reviewer: confirm the page-level status gate is present and correct, and that no code path renders the unlocked branch for a non-`interviewing` status.
- **S3 — no logging of private activity.** The client button must not `console.*`; a test pins it. A status transition is tied to the user's application activity.
- **S4 — no client-side persistence.** The button holds nothing in `localStorage`/`sessionStorage`/cookies/URL; it fires one PATCH and refreshes.

**Concurrency**

- **R1 — status transition is last-write-wins (FIT-01, documented).** Two tabs both clicking "I got the interview" both set `interviewing` (idempotent outcome); a concurrent transition to a different status is last-write-wins with no version column. Accepted for v1 — **do not add a lock or If-Match here**; that is FIT-01's documented contract, not this ticket's call.
- **R2 — refresh-window double-PATCH is prevented** by `done` gating `disabled` (§2.3): after a 200 the button stays disabled through the refresh, and in production unmounts when the unlocked branch renders. Reviewer: confirm `refresh()` is on the 200 path only and `done` is set before it.

**Correctness / build**

- **R3 — first `useRouter` in the repo; the test MUST mock `next/navigation`.** Under real jsdom with no App Router provider, `useRouter()` **throws** "invariant expected app router to be mounted" (verified pattern; this is why every server test mocks `notFound`). Both the button test **and** the lock-screen test (which renders the button) mock `useRouter: () => ({ refresh: … })`. Import from **`next/navigation`**, never `next/router` (the Pages-Router hook has no `.refresh()` and throws in the app dir). If the Builder sees a mysterious "invariant" failure, the mock is missing.
- **R4 — the unlocked placeholder must stay inert (zero fetch).** PRP-03 makes no RESEARCH/REHEARSE call even in the unlocked branch (ticket Non-goals + Deliverable 3); PRP-04 adds them. Test 5 (§3) pins zero fetch on every render, including `interviewing`. Do not "get a head start" on PRP-04's orchestration.
- **R5 — Next 15 async `params`.** `params` is a Promise in `page.tsx`; a non-Promise type type-checks in isolation and fails `next build`'s generated route-type check in CI. Run `corepack pnpm build` with `DATABASE_URL` unset before calling the ticket done.
- **R6 — static vs lazy import of `getJob`.** `page.tsx` imports `@/lib/db/queries/jobs` statically (it is import-safe with `DATABASE_URL` unset via its memoized lazy `dbIndex()`), matching the Fit and resume pages; the build-guard test (§3 test 11) pins that the page module imports cleanly without the env. Do **not** add a top-level `@/db/index` import.
- **R7 — the two `getJob` reads per detail request.** `layout.tsx` reads the job (for the header + tab lock) and `page.tsx` reads it again (for `job.status`). App Router layouts cannot pass data to pages; this is FIT-03's accepted, documented D2 cost. Do not invent a `_lib/` shared reader (outside this ticket's file-scope, and PRP-04 owns no such folder either).
- **R8 — PRP-04 shares this file.** PRP-04 replaces the unlocked-branch placeholder and its test (test 4), and may restructure the file — but **must** preserve the locked-state behavior (tests 1–3 + all button tests). This plan keeps the branch boundary clean (`if (job.status !== 'interviewing') return <LockScreen …>`) so PRP-04's extension is a localized swap of the `return` after the guard. Reviewer/PRP-04 Builder: the transient placeholder assertion is expected to change; the locked behavior is not.

---

## 5. Open questions

| # | Question | Owner / how it gets decided |
|---|---|---|
| Q1 | `useRouter().refresh()` vs `window.location.reload()` for the post-PATCH re-render. | **Decided in this plan: `router.refresh()`** (honors the ticket's explicit "Next.js router refresh", cleaner UX, correctly re-renders both the layout tab nav and this page). Recorded as the repo's first `useRouter` use in the ticket Changelog. It is trivially reversible — if the Reviewer or Horace prefers the `window.location` precedent, it is a one-line swap, not a re-plan. **Non-blocking.** |
| Q2 | Exact lock-screen copy ("Prep unlocks after you get an interview.") and button label ("I got the interview"). | **Builder**, within Feedback obligation #1's i18n-tone latitude. If refined beyond this plan's suggestion, log a one-line entry in `docs/prd/06-prep/README.md`'s Changelog (Chinese). PRD §5.4/§5.8 give the intent; the exact English is not PRD-fixed. **Non-blocking.** |
| Q3 | Whether `06-prep`'s lock copy should ever be unified with FIT-03's `job-tabs.tsx` `PREP_LOCKED_COPY`. | **Product/UX (Horace), later.** This plan deliberately keeps them separate (different contexts, no cross-module coupling — §2.2). If a single source of truth is later wanted, that is a breakdown-plan-level question about a shared UI-copy module, not a quiet cross-module import. **Non-blocking; recorded, not acted on.** |

No blocking open questions. This ticket has no upstream-conflict escalation (unlike FIT-01) — it builds entirely on already-merged, already-reviewed contracts.

---

## 6. ADR candidates

**None from this ticket.** The ticket header itself states "No ADR — the decision is already made in PRD §5.4 and §5.7." The hard-to-reverse architectural choice in this module — "Fit/Prep is one user-facing operation billed once, delivered as multiple server calls" — is already pre-registered as ADR-A / ADR-0001 by PRP-01/PRP-02 and `breakdown-plan.md` §6, and **this ticket touches none of it** (no quota, no paid call, no schema). Introducing `useRouter().refresh()` (§2.3) is a conventional client pattern, trivially reversible, and is recorded as a plan decision + ticket-Changelog note — not ADR-worthy. Do **not** create any file in `docs/adr/`.

---

## 7. Build sequence (suggested order; each step ends green)

0. `git switch -c ticket/PRP-03` from `main` at `346307d`. Confirm the baseline: `corepack pnpm test` → ≥ 80 files / 1087 tests green.
1. **`status-transition-button.tsx` + its test** (§2.3, §3). Green. (Build the leaf client component first — the button test is acceptance item 2, the load-bearing one.)
2. **`lock-screen.tsx` + its test** (§2.2, §3). Green.
3. **`page.tsx` + its test** (§2.1, §3). Green. (Includes the `force-dynamic`, `notFound`, drift-propagation, no-fetch-on-render, and build-guard tests.)
4. **`corepack pnpm build` with `DATABASE_URL` unset** → exit 0; confirm `/jobs/[id]/prep` is in the route table (catches R5/R6 before the Reviewer does).
5. **Ticket Changelog writeback** (§1) — the `router.refresh()` decision, the lock-screen-copy decision, deviations, wording choices, and the final test counts; plus a `06-prep/README.md` Changelog line only if the copy/label was refined.
6. Final `corepack pnpm test` (≥ baseline + new) and `corepack pnpm lint` clean.
