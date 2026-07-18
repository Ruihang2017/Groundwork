# Implementation plan — FND-09: App shell, sign-in page, and Vercel deploy pipeline

Ticket: [docs/prd/01-foundation/tickets/FND-09-app-shell-deploy.md](../prd/01-foundation/tickets/FND-09-app-shell-deploy.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md) (v0.5)
Master spec: [docs/PRD.md](../PRD.md) §0 (one-liner), §8.1 (stack pin + "托管：自有硬件 → Vercel + Neon"), §5.8 ("UI 英文"), §10 P0 ("repo、Auth.js、Drizzle schema、Vercel 部署流水线 … 注册/登录可用，空应用在线")
Breakdown plan file-ownership: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) line 46 (`app/layout.tsx`, `app/page.tsx`, `app/(auth)/signin/page.tsx` → `01-foundation`/FND-09 creates; PLT-04 appends an invite-code field, no restructure), line 53 (`.github/workflows/ci.yml` → FND-01 created, this ticket appends), line 229 (`app/(auth)/signin/page.tsx` is one of four files explicitly allowed cross-module append).
Depends on (merged into `main` as of this plan): FND-01 (placeholder `app/layout.tsx`/`app/page.tsx`, `.github/workflows/ci.yml`), FND-08 (`auth.ts`, `auth.config.ts`, `middleware.ts`, `lib/auth/session.ts`, `app/api/auth/[...nextauth]/route.ts` — merged via `5c9102c` "Merge ticket/FND-08 into main… (CLEAR after 1 bounce)").
Downstream: `03-library`/`04-fit` replace `app/(app)/**` placeholder content (see §1/§4 for exactly which file); `07-platform-launch`/PLT-04 appends an invite-code field to the sign-in page this ticket creates.

ADR status: none required for the core decision (PRD §8.1/§10 already mandate Vercel + a deployable Next.js shell; the ticket says so explicitly). One sub-decision this plan makes — using `next-auth/react`'s client-safe `signIn` instead of `@/auth`'s server-only export inside the sign-in page — is flagged as an ADR-candidate for future awareness in §6, not a new ADR today.

## 0. Repo-state check performed for this plan (verified by direct inspection 2026-07-18/19, do not re-derive)

Current branch is `main` (FND-08 already merged via `5c9102c`, CLEAR after one bounce cycle). Verified facts, each confirmed by reading the actual file or by running a real command in this environment — not guessed:

1. **`app/layout.tsx`/`app/page.tsx` are FND-01's placeholders**, each carrying the literal comment `// FND-09 replaces this — see docs/prd/01-foundation/tickets/FND-09-app-shell-deploy.md`. `app/page.tsx` currently `return null`. Confirms FND-01's Feedback-obligation #2 anticipation was honored — no surprise collision on these two files.
2. **`middleware.ts` (FND-08, post-bounce-fix) already fully satisfies this ticket's acceptance item 3.** `PUBLIC_PATHS = new Set(['/', '/signin'])`; matcher `'/((?!api/|_next/static|_next/image|favicon.ico).*)'` (segment-scoped `api/`, the FND-08 Reviewer finding #3 fix). `middleware.test.ts` (root, already merged) is explicitly labeled `describe('middleware — request handling (acceptance item 3)')` and asserts: unauthenticated request to a representative protected path (`/jobs`) → redirects to `/signin`; authenticated request to the same path passes through; `/` and `/signin` pass through unauthenticated. **This ticket needs no new middleware test** — `/jobs` is used generically as "a representative protected page path," which covers any future protected route including the one this ticket adds (§1). `middleware.ts` is not in this ticket's file-scope and this plan does not touch it or its test file.
3. **`auth.ts` exports `signIn`/`signOut` that are NOT callable from a Client Component.** Read directly from the installed package (`node_modules/.pnpm/next-auth@5.0.0-beta.31.../next-auth/lib/actions.js`): both `signIn()` and `signOut()` import `next/headers` (`headers`, `cookies`) and `next/navigation`'s `redirect` at module top — all server-only APIs. A `'use client'` file that imports `@/auth` (which re-exports these) fails Next.js's client/server boundary check at build time (`next/headers` cannot be imported into code reachable from a `'use client'` module). **The ticket's Deliverable 3 wording ("client component… calls FND-08's `signIn('google')`") is therefore not literally achievable via a same-file import of `@/auth`'s `signIn`.** Resolution (§1/§2.3): use `next-auth/react`'s client-safe `signIn`/`getCsrfToken`-backed implementation instead — confirmed by reading `next-auth/react.js` directly: the module is marked `"use client"` at its own top (line 12), and `signIn()` (line 126) does a plain browser `fetch()` against `/api/auth/**`, reading only a module-level `__NEXTAUTH` config object that defaults sanely with no `<SessionProvider>` required (this page uses no `useSession()`, so no provider is needed at all). This is Auth.js's own officially-supported "Client Components" API surface (see the module's own doc comment, line 3–8: "It supports both Client Components… and the Pages Router"), not a workaround — flagged as an interpretive resolution for the Reviewer in §5 Q1, mirroring FND-08 plan's own precedent of flagging such disambiguations rather than burying them.
4. **`next-auth`'s React-Server-Component `auth()` path calls `headers()` before it invokes the lazy config factory.** Read directly (`next-auth/lib/index.js`, `initAuth`'s zero-arg branch, used by a bare `await auth()` call from a Server Component): `const _headers = await headers(); const _config = await config(undefined); …`. `headers()` runs first. This matters because `config` here is `auth.ts`'s `buildAuthConfig`, which dynamic-imports `@/db/index` — and `db/index.ts` throws synchronously at module-evaluation time whenever `DATABASE_URL` is unset (verified: `db/index.ts` lines 9–15; regression-tested by `db/index.test.ts`). This ordering is why calling `auth()` from `app/layout.tsx` (Deliverable 1) does not reintroduce FND-08's own Reviewer finding #1 ("clean-checkout `pnpm build` blocker") even though a root layout's render function genuinely executes (partially) during `next build`'s "Generating static pages" phase — Next bails out of static rendering at the `headers()` call, which fires strictly before `config(undefined)`/`db/index.ts` would ever be reached. §4 still requires the Builder to empirically re-verify this with a real `pnpm build` (`DATABASE_URL` unset) as non-negotiable proof, and this plan additionally recommends `export const dynamic = 'force-dynamic'` on `app/layout.tsx` as cheap defense-in-depth that removes any reliance on this internal ordering detail (§2.1).
5. **`app/(app)/page.tsx`, taken literally as the ticket's File-scope states it, collides with `app/page.tsx` at the URL level and will fail `next build`.** Route groups (`(app)`, `(auth)`) add no URL segment — `app/(app)/page.tsx` resolves to `/`, the exact same URL `app/page.tsx` (Deliverable 2, the public landing page) also resolves to. Verified directly in the installed Next.js build tooling: `node_modules/next/dist/build/webpack/loaders/next-app-loader/index.js` contains the exact check and throw — `"You cannot have two parallel pages that resolve to the same path. Please check ${existingChildrenPath} and ${appPath}…"` (error code `E28`) — fired whenever two sibling page files (one of them inside a route group) resolve to an identical path. Given the ticket's own Non-goals text is explicit that `/` must be the **public** landing page and the middleware's already-merged `PUBLIC_PATHS` hard-codes `/` as public, the only coherent fix is to give the `(app)` group's placeholder a real, distinct, non-`/` URL — this plan resolves it as `app/(app)/home/page.tsx` → `/home` (§1/§2.4). This is a deviation from the ticket's literal File-scope text; the Builder must record it in the ticket's own Changelog per its Feedback obligation, and it is flagged for Reviewer sign-off in §5 Q2.
6. **`pnpm` is not on PATH in this environment** (consistent with FND-01 Changelog v0.2's documented Corepack friction), but `node` (v22.11.0) and the already-installed `node_modules/.bin/next` are present and usable directly. Confirmed empirically: `node_modules/.bin/next.CMD build` with `DATABASE_URL` unset, run against the **current, unmodified** tree (FND-01/FND-08 state only, none of this ticket's changes yet), succeeds — `✓ Compiled successfully`, `✓ Generating static pages (4/4)`, route table shows `○ / ` (static — no `auth()` call in the layout yet), `ƒ /api/auth/[...nextauth]`, `ƒ Middleware`. This is the pre-ticket baseline the Builder's own `pnpm build` run (§3 item 1) must be compared against; after this ticket's changes, `/`, `/signin`, `/home` are all expected to become `ƒ (Dynamic)` (not `○ (Static)`) because the root layout now reads live auth state — this is expected, correct behavior, not a regression to chase.
7. **No `docs/adr/` directory exists** — nothing there touches this ticket's area (same as every prior FND plan has confirmed).
8. **No existing `.tsx` test file anywhere in this repo** (`find . -iname "*.test.ts"` returns only `.test.ts` files — `middleware.test.ts`, `auth.config.test.ts`, `auth.test.ts`, `lib/**`, `db/**`). This ticket's sign-in-page component test is the **first** `.tsx`/React-rendering test in the whole codebase — the vitest/jsdom/`@vitejs/plugin-react` wiring in §2.6 has no precedent to copy and must be gotten right the first time, in the same spirit as every prior FND ticket's `vitest.config.ts` `test.include` "false-green" writeback (see `01-foundation/README.md` v0.3/v0.4/v0.5 changelog entries).
9. **`package.json` currently has no `@testing-library/*`, `jsdom`, or `@vitejs/plugin-react`** (checked directly). `vitest.config.ts`'s `test.include` is `['tests/**/*.test.ts', 'lib/**/*.test.ts', 'db/**/*.test.ts', '*.test.ts']` — none of these globs reaches `app/**`.
10. **`.env.example`** currently lists `ANTHROPIC_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `GLOBAL_DAILY_SPEND_LIMIT_USD` — these are **application runtime** env vars (Vercel project / `.env.local`), a different mechanism from the **GitHub Actions repo secrets** (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`) this ticket's CI deploy step needs. This ticket does not touch `.env.example` — the Vercel secrets belong in GitHub's repo secrets UI, not this file (§2.5/§5 notes this distinction explicitly so the Builder doesn't conflate the two).

## 1. Scope

**In scope** (matches the ticket's Goal/Deliverables, reconciled against §0's findings):

- `app/layout.tsx` — root layout: `auth()`-aware header (Sign in link / Sign out form), `force-dynamic` segment config (§2.1).
- `app/page.tsx` — public landing page, English copy translated from PRD §0, CTA to `/signin` (§2.2).
- `app/(auth)/signin/page.tsx` — `'use client'` sign-in page: Google button + magic-link email form, both calling `next-auth/react`'s `signIn` (not `@/auth`'s), invite-code insertion-point comment for PLT-04 (§2.3).
- `app/(app)/home/page.tsx` (**not** `app/(app)/page.tsx` — see §0.5) — placeholder authenticated-area landing, proves the `(app)` route group's middleware protection end to end (§2.4).
- `.github/workflows/ci.yml` — append one `Deploy to Vercel` step after the existing `Build` step, gated to `main` pushes, delegating its no-op logic to a new standalone script so the no-op path is directly unit-testable (§2.5).
- `.github/scripts/deploy-vercel.mjs` (new) — the deploy step's actual logic: no-ops (exit 0) when `VERCEL_TOKEN` is unset, otherwise invokes the Vercel CLI via `npx`.
- `app/(auth)/signin/page.test.tsx` (new) — component test, acceptance item 2.
- `tests/deploy-vercel.test.ts` (new) — spawns the real deploy script with `VERCEL_TOKEN` unset, acceptance item 4.
- `vitest.config.ts` — add `@vitejs/plugin-react` to `plugins`, widen `test.include` with `'app/**/*.test.{ts,tsx}'` (§2.6).
- `package.json` / `pnpm-lock.yaml` — add `@testing-library/react`, `jsdom`, `@vitejs/plugin-react` as devDependencies (exact versions the Builder resolves and records, per this repo's pin-exact convention — see FND-08 plan §2.8). No new **runtime** dependency: `next-auth/react` is a submodule of the already-installed `next-auth` package (§0.3).
- `docs/prd/01-foundation/tickets/FND-09-app-shell-deploy.md` — Changelog entry recording the `/home` deviation (§0.5) and the client-signIn-API resolution (§0.3).
- `docs/prd/01-foundation/README.md` — mirrored changelog line (module convention, v0.5 → v0.6).

**Explicitly NOT in scope** (per ticket Non-goals, confirmed against §0):

- No `vercel.json`. Next.js's zero-config Vercel deployment is sufficient for this stack: Auth.js's Edge middleware already builds clean (FND-08, confirmed), and the DB driver (`@neondatabase/serverless`'s `neon-http`, an HTTP/fetch-based driver — see `db/index.ts` comment) needs no connection-pooling mode config, which was the ticket's own named reason a `vercel.json` might be needed. This satisfies the ticket's own stated preference ("if this ticket ends up NOT needing the file at all, that satisfies PRD §8.1's '无聊技术栈' spirit… acceptable Deviation to record") — record as a Deviation in the ticket Changelog, not silently.
- No `app/(app)/library/**`, `app/(app)/jobs/**`, `app/(legal)/**`, `app/(admin)/**` — other modules' territory.
- No invite-code UI — PLT-04.
- No real Vercel project creation, env var configuration, or domain binding — Horace's task (Feedback obligation).
- No edits to `middleware.ts`, `auth.ts`, `auth.config.ts`, `lib/auth/session.ts`, `db/**`, `.env.example` — all owned by earlier, already-merged FND tickets; this ticket only **consumes** their exports.
- No design system / CSS framework — ticket explicitly defers this; use plain semantic HTML, no new stylesheet file (keeps file-scope to exactly what's listed).
- No `SessionProvider` — not needed (§0.3); would be unrequested scope creep and would force `app/layout.tsx` itself to become a Client Component boundary, contradicting Deliverable 1's explicit "calls `auth()` server-side."

## 2. Change list

### 2.1 `app/layout.tsx` (replace FND-01's placeholder)

Server Component (`async function`), calls `auth()` directly (safe per §0.4), renders a header:

- If `session?.user` is truthy: show the user's `name`/`email` plus a `<form action={...}>` whose action is an **inline Server Action** (`'use server'` closure) calling `signOut()` from `@/auth` — the officially documented Auth.js v5 App Router pattern for a non-interactive (no client JS needed) sign-out control. This is safe to call `signOut` here (unlike `signIn` in the sign-in page, §0.3) because inline Server Actions are never invoked during `next build` — only on a real POST at runtime — so the `next/headers` dependency inside `signOut()` (§0.3) never executes at build time regardless.
- Else: `<Link href="/signin">Sign in</Link>` (`next/link`).
- Top of file: `export const dynamic = 'force-dynamic';` with a comment citing §0.4/§0.6 — this layout inherently needs live per-request auth state (there is no meaningful static version of it), and this explicitly documents that intent rather than relying on Next's dynamic-API-bailout ordering as the only safety net.
- No new CSS/stylesheet file; minimal inline styling or unstyled semantic markup only (ticket's explicit deferral, §1).

No test file is required specifically for this (no acceptance item names it); it is exercised indirectly by acceptance item 1 (`pnpm build`) and can optionally get a lightweight render smoke test at the Builder's discretion, not mandatory.

### 2.2 `app/page.tsx` (replace FND-01's placeholder)

Server Component, static-ish content (no `auth()` call needed here — the header already shows sign-in state):

- An English one-liner translated from PRD §0 ("把求职者的真实经历（简历）解析成结构化背景库，在求职漏斗的每一步兑现为可辩护的产出") per PRD §5.8's "UI 英文" mandate — e.g. *"Turn your real experience into a structured background library — and turn that library into a defensible output at every step of the job search."* Exact wording is the Builder's call; the plan does not lock copy, only the citation basis.
- `<Link href="/signin">` CTA (ticket's literal wording).
- Product name: use "Groundwork" (matches `package.json`'s `name` field) as a working title — final product naming is `01-foundation/README.md` open question #1, owner Horace; do not treat this as final branding.

### 2.3 `app/(auth)/signin/page.tsx` (new)

`'use client'` component. Imports `signIn` from `'next-auth/react'` — **not** `@/auth` (§0.3). Renders:

- A "Continue with Google" button: `onClick={() => signIn('google', { callbackUrl: '/home' })}`.
- An email magic-link form with a controlled `email` input (`useState`) and `onSubmit` (with `e.preventDefault()`) calling `signIn('resend', { email, callbackUrl: '/home' })`.
- `callbackUrl: '/home'` is a deliberate, low-cost addition beyond the ticket's literal text: `next-auth/react`'s `signIn()` defaults `redirectTo` to `window.location.href` (the current page) when no `callbackUrl` is given (verified in `react.js` line 128) — without an explicit target, a successful sign-in would bounce the user back to `/signin` itself. Passing `/home` (this ticket's own placeholder authenticated page, §2.4) directly serves the ticket's own Goal text ("...such that... a user can register/sign in").
- A clearly marked insertion point for PLT-04, per the ticket's own suggested form: an HTML comment inside the form JSX, e.g. `{/* INVITE_CODE_INSERTION_POINT — PLT-04 (07-platform-launch) inserts an <InviteCodeField /> input here; append only, do not restructure this form. */}`. (The ticket's alternative suggestion — an optional prop — does not fit a route `page.tsx`, which Next.js instantiates with route props only, not caller-supplied props; a marked comment is the workable reading of "e.g. ... or an optional prop.")
- No `redirect: false` / custom "check your email" UI — Auth.js's own default `verify-request` page covers this adequately; not required by any acceptance item, avoid unrequested scope creep.

### 2.4 `app/(app)/home/page.tsx` (new — replaces the ticket's literal `app/(app)/page.tsx`, see §0.5)

Server Component, no interactivity needed:

```
// Placeholder authenticated-area landing page (FND-09). 03-library (Library page,
// /library) and 04-fit (Jobs pages, /jobs) land the real authenticated-area content
// in later modules — this file exists only to prove the (app) route group's
// middleware protection works end to end. Lives at /home, not bare `/`, because
// `app/(app)/page.tsx` (the ticket's literal File-scope path) would resolve to the
// exact same URL as the public app/page.tsx and fail `next build` with Next's
// "two parallel pages resolve to the same path" error — see docs/plans/FND-09.md §0.5.
export default function AuthenticatedHome() {
  return <p>Signed in. Library and Jobs pages land in later modules.</p>;
}
```

No dedicated test required — already covered generically by FND-08's existing `middleware.test.ts` (§0.2) and by acceptance item 1's `pnpm build`.

### 2.5 `.github/workflows/ci.yml` (append) + `.github/scripts/deploy-vercel.mjs` (new)

Append one step to the existing single `build` job, after the current `Build` step:

```yaml
      - name: Deploy to Vercel
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
        run: node .github/scripts/deploy-vercel.mjs
```

The `if:` gate keeps deploy attempts off PRs/feature branches even after Horace eventually adds real secrets (deploy should only ever fire from `main`); this is defense-in-depth layered on top of the script's own no-op check, not a substitute for it (the acceptance item is about the *script's* behavior, §3 item 4).

`.github/scripts/deploy-vercel.mjs`:

```js
#!/usr/bin/env node
// Invoked by .github/workflows/ci.yml's "Deploy to Vercel" step (FND-09
// Deliverable 5). No-ops gracefully (exit 0, no error) when VERCEL_TOKEN is unset —
// real Vercel project creation/secrets are Horace's manual task (ticket Feedback
// obligation #2), so this step must never hard-fail CI before that happens.
// Extracted to a standalone script (not inline YAML) specifically so the no-op path
// is directly, deterministically unit-testable — see tests/deploy-vercel.test.ts.
import { execFileSync } from 'node:child_process';

const token = process.env.VERCEL_TOKEN;

if (!token) {
  console.log('no VERCEL_TOKEN configured, skipping deploy');
  process.exit(0);
}

// Exact version pinned deliberately (no floating @latest), matching this repo's
// dependency-pinning convention (see FND-08 plan §2.8) — Builder: confirm the
// current stable `vercel` CLI release at build time and fill in the pin below.
execFileSync(
  'npx',
  ['--yes', 'vercel@<PIN_ME>', 'deploy', '--prod', '--token', token, '--yes'],
  { stdio: 'inherit' },
);
```

Never `console.log` the token itself; the current design doesn't (§4 security note).

### 2.6 `vitest.config.ts` (append)

```diff
+import react from '@vitejs/plugin-react';
 import { fileURLToPath } from 'node:url';
 import { defineConfig } from 'vitest/config';

 export default defineConfig({
+  plugins: [react()],
   test: {
     environment: 'node',
     include: [
       'tests/**/*.test.ts',
       'lib/**/*.test.ts',
       'db/**/*.test.ts',
       '*.test.ts',
+      'app/**/*.test.{ts,tsx}',
     ],
   },
   resolve: {
     alias: {
       '@': fileURLToPath(new URL('.', import.meta.url)),
     },
   },
 });
```

`@vitejs/plugin-react` is required (not optional) because `tsconfig.json`'s `"jsx": "preserve"` is SWC/Next.js-specific — Vite/Vitest's own transform pipeline needs the plugin to correctly parse JSX in `.tsx` files (both the new test file and, transitively, `app/(auth)/signin/page.tsx` itself, which the test imports). This is the same setup Next.js's own official Vitest testing guide documents for exactly this stack — not a novel choice.

Global `environment` stays `'node'` (unchanged) — do **not** flip it to `'jsdom'` globally; that would add DOM-shaped globals to every existing `db/**`/`auth*`/`middleware` test for no benefit and is a needless blast-radius increase. Instead, scope jsdom to the one new component test file via Vitest's per-file magic comment `// @vitest-environment jsdom` at the top of `app/(auth)/signin/page.test.tsx` (requires the `jsdom` package installed, §1, but not a global config change).

### 2.7 `app/(auth)/signin/page.test.tsx` (new)

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

import { signIn } from 'next-auth/react';
import SignInPage from '@/app/(auth)/signin/page';

describe('SignInPage (acceptance item 2)', () => {
  it('renders a Google button and an email magic-link form', () => {
    render(<SignInPage />);
    expect(
      screen.getByRole('button', { name: /continue with google/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
  });

  it('clicking "Continue with Google" calls signIn("google", …) — not a real OAuth call', () => {
    render(<SignInPage />);
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    expect(signIn).toHaveBeenCalledWith(
      'google',
      expect.objectContaining({ callbackUrl: '/home' }),
    );
  });

  it('submitting the email form calls signIn("resend", { email, … })', () => {
    render(<SignInPage />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(signIn).toHaveBeenCalledWith(
      'resend',
      expect.objectContaining({
        email: 'user@example.com',
        callbackUrl: '/home',
      }),
    );
  });
});
```

Mocking `next-auth/react`'s `signIn` (rather than `@/auth`'s) is the correct target given §0.3/§2.3's resolution — it is the actual function the page calls, and mocking it fully satisfies the acceptance item's intent ("mocking FND-08's signIn, not making real OAuth calls": no real network/OAuth call happens either way). Flagged for the Reviewer in §5 Q1 since it is an interpretive reading of "FND-08's signIn," not a literal same-symbol match.

`@testing-library/jest-dom` is optional (nicer matchers, e.g. `.toBeInTheDocument()`) — the Builder may add it; the sketch above avoids depending on it (`.toBeTruthy()`/`toHaveBeenCalledWith` alone suffice) to keep the minimum-required-dependency set unambiguous.

### 2.8 `tests/deploy-vercel.test.ts` (new)

```ts
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = path.join(repoRoot, '.github', 'scripts', 'deploy-vercel.mjs');

describe('.github/scripts/deploy-vercel.mjs — CI deploy no-op guard (acceptance item 4)', () => {
  it('exits 0 and logs a clear message when VERCEL_TOKEN is unset (no real deploy attempted)', () => {
    const env = { ...process.env };
    delete env.VERCEL_TOKEN;

    const result = spawnSync('node', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no VERCEL_TOKEN configured, skipping deploy');
  });
});
```

Covered by the existing `tests/**/*.test.ts` glob — no `vitest.config.ts` change needed for this file specifically. This genuinely runs the same script the CI workflow invokes (not a re-implementation of its logic), satisfying the acceptance item's literal "verified by running the workflow's deploy step logic locally with the env var unset" wording. The real-deploy path (`VERCEL_TOKEN` present) is intentionally untested — it requires a real Vercel account/project, out of scope per the ticket's own Feedback obligation, same pattern every prior FND ticket has followed for credentials it cannot obtain.

### 2.9 Ticket + sub-PRD writebacks

`docs/prd/01-foundation/tickets/FND-09-app-shell-deploy.md` — Changelog v0.1 recording: the `/home` vs. literal `app/(app)/page.tsx` deviation (§0.5), the `next-auth/react` vs. `@/auth` signIn resolution (§0.3), the "no `vercel.json`" decision (§1), and the exact `vercel` CLI version pinned (§2.5, filled in at build time). `docs/prd/01-foundation/README.md` — mirrored summary, v0.5 → v0.6, plus the module-level `[human]` acceptance checkbox context (P0 exit criteria, still blocked on Horace per Feedback obligation #2 either way).

## 3. Test plan

Maps to the ticket's acceptance checklist; everything offline (no live Vercel/OAuth/DB credentials anywhere in this ticket's own tests, matching every prior FND ticket's convention).

1. **`pnpm build` (or `node_modules/.bin/next build`), `DATABASE_URL` unset — acceptance item 1.** Must exit 0 with all four real files in place. Non-negotiable empirical check (not citation-only) given §0.4/§0.5's findings — confirm the build output's route table shows `/`, `/signin`, `/home` (not the collided `/(app)/page.tsx`) and that `/`/`/signin`/`/home` render as `ƒ (Dynamic)` (expected, since the shared root layout now reads live auth state — see §0.6 baseline for what "before" looked like). If this step fails with a `DATABASE_URL is not set` error, the root cause is almost certainly the ordering assumption in §0.4 not holding for this exact `next-auth@5.0.0-beta.31`/Next.js `15.5.20` pairing — the `export const dynamic = 'force-dynamic'` already recommended in §2.1 is the fix; if already present and still failing, treat as a new, higher-priority Reviewer-flagged finding (this exact failure mode already bounced FND-08 once — do not treat a recurrence casually).
2. **`app/(auth)/signin/page.test.tsx` — acceptance item 2.** As sketched in §2.7; run for real, not just read, to catch any JSX-transform/jsdom wiring mistakes (§0.8/§0.9's "first `.tsx` test in the repo" risk).
3. **Acceptance item 3 (middleware redirect) — already satisfied, no new test.** Confirmed in §0.2. Re-run the full `pnpm test` suite and confirm `middleware.test.ts` is still green (regression, not a new assertion).
4. **`tests/deploy-vercel.test.ts` — acceptance item 4.** As sketched in §2.8.
5. **`pnpm test` green — the standing acceptance item.** Full suite, including every pre-existing FND-01…FND-08 test file, must stay green after the `vitest.config.ts`/`package.json` changes (§2.6) — this is the same "did the shared config change break anything else" check every prior FND ticket's Changelog has explicitly performed.
6. **`git diff --stat main..HEAD` matches exactly this plan's file list (§1)** — nothing outside file-scope touched, and the one deliberate deviation (`app/(app)/home/page.tsx` instead of `app/(app)/page.tsx`) is the only File-scope departure, recorded in the ticket Changelog per §2.9.

## 4. Risks & edge cases

- **[Highest priority] Route collision, §0.5.** If the Builder implements the ticket's File-scope literally (`app/(app)/page.tsx`), `pnpm build` fails outright with Next's `E28` "two parallel pages resolve to the same path" error — this would be caught immediately by acceptance item 1, but wastes a full build cycle rediscovering what this plan already found. Verified via direct inspection of the installed Next.js build tooling (§0.5), not speculation.
- **[High priority] Build-time DB-independence regression, §0.4/§0.6.** This ticket is the second place in the codebase (after FND-08's middleware/API route) where `auth()`/`buildAuthConfig()` gets exercised on a path `next build` actually executes — a root layout's Server Component render, not just a statically-analyzed module graph. The ordering argument in §0.4 is sound for the *currently installed* `next-auth@5.0.0-beta.31`, but this is a prerelease (`beta`) package — a future `pnpm install` resolving a different beta could change `initAuth`'s internal ordering. `export const dynamic = 'force-dynamic'` (§2.1) is deliberately layered on top as a version-independent guarantee, not merely a citation of current library internals. Treat item 1 in §3 as the actual proof, every time this ticket (or its plan) is revisited.
- **`@/auth`'s `signIn`/`signOut` vs. `next-auth/react`'s client API split, §0.3.** This ticket ends up using **two different Auth.js call surfaces** for what is conceptually "the same" sign-in/out flow: `@/auth`'s server-only `signOut` (via an inline Server Action in the header, §2.1) and `next-auth/react`'s client-only `signIn` (in the sign-in page, §2.3). This is not a stylistic inconsistency — it's forced by the Client/Server Component boundary (§0.3) — but a future maintainer unfamiliar with this constraint could "simplify" one to match the other and silently break the build (importing `@/auth`'s `signIn` into a `'use client'` file) or reduce testability (switching the header's `signOut` to a client `next-auth/react` call would require promoting `app/layout.tsx` to a Client Component, breaking Deliverable 1's explicit "calls `auth()` server-side" requirement). Both hazards are cheap to prevent with clear in-file comments (§2.1/§2.3 code sketches already include the rationale) — Reviewer should confirm the comments survive into the actual implementation.
- **Security-sensitive: the Vercel deploy script must never leak `VERCEL_TOKEN`.** The script (§2.5) passes the token as a literal CLI argument to `npx vercel …`, never logs it, and GitHub Actions itself masks any known-secret substring in step output — standard, accepted practice for CI credential usage. Do not add debug logging that echoes `process.env` wholesale in this script or its test.
- **The `if:` branch gate (`github.ref == 'refs/heads/main' && github.event_name == 'push'`) is deploy-safety, not test-safety** — the acceptance item under test (§3 item 4) exercises the *script* directly, bypassing GitHub Actions' `if:` evaluation entirely (which cannot be unit-tested outside a real Actions runner). Don't conflate "the script no-ops" (tested) with "the workflow only attempts deploy on `main`" (untested, reviewed by inspection only) — both are needed, only one is machine-verified.
- **Concurrency:** none applicable — this ticket introduces no shared mutable state, no new DB writes, no new API routes. Lower-risk category than FND-05/FND-08's own flagged concurrency items (session/token races), explicitly noted here so the Reviewer doesn't need to hunt for a concurrency angle that doesn't exist in this ticket's surface.
- **`app/page.tsx`'s copy is a placeholder translation, not final branding** — product name/domain is `01-foundation/README.md` open question #1 (owner Horace); don't over-invest in landing-page wording polish this ticket doesn't need to get exactly right.
- **`callbackUrl: '/home'` (§2.3) creates a soft coupling** between the sign-in page and the exact placeholder route this ticket also creates (§2.4) — if a later ticket renames/removes `/home` without updating both call sites, a successful sign-in would silently 404 rather than break loudly. Low risk (both files are in this same ticket's diff, easy to keep in sync now) but worth a one-line comment at each call site pointing at the other (already included in §2.3/§2.4's sketches).

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether mocking `next-auth/react`'s `signIn` (§0.3/§2.3/§2.7) — rather than a literal same-symbol import from `@/auth` — is an acceptable reading of the acceptance item's "mocking FND-08's signIn." This plan's position: yes, `@/auth`'s `signIn` is provably uncallable from a `'use client'` file (§0.3), so no literal reading exists; the client-safe API is Auth.js's own documented alternative for exactly this use case. | Reviewer, at review time — cheap to confirm, flagged rather than buried per this repo's established convention (mirrors FND-08 plan §5 Q2's own signIn-callback-vs-action disambiguation). |
| 2 | Whether `app/(app)/home/page.tsx` (this plan's chosen URL, §0.5/§2.4) is the right slug for the ticket's file-scope deviation, versus an alternative like `/dashboard` or `/app`. Functionally any non-`/`, non-`/signin` path works identically (middleware protects by default); `/home` was chosen for readability, not because the PRD names it. | Reviewer now (cheap to rename before any other ticket references it); reconsider at Horace's Gate 2 smoke test if it reads oddly in practice. |
| 3 | `docs/prd/breakdown-plan.md`'s file-ownership table (line 46/56) does not currently grant any downstream ticket ownership of "replace the `(app)` group's own index route" — `03-library` owns only `app/(app)/library/**`, `04-fit` owns only `app/(app)/jobs/**`. If a later module wants `/home` (or whatever it's renamed to, per Q2) to become a real "which page do I land on after login" router instead of a static placeholder, no ticket currently claims that file. Not blocking for FND-09 — flagged now so it isn't rediscovered as a surprise later, same pattern as FND-08 plan §5 Q3's middleware-allowlist-ownership question. | Horace / whichever Architect plans the module that eventually wants a real post-login landing page. |
| 4 | The exact `vercel` CLI version to pin in `.github/scripts/deploy-vercel.mjs` (§2.5) — this plan could not verify the current stable release without live internet access in this environment, and it is not exercised by any automated test in this ticket (the real-deploy code path only runs once Horace supplies `VERCEL_TOKEN`, per Feedback obligation #2/#3). | Builder, at build time — check npm for the current `vercel` package release and pin it exactly (no floating `@latest`), matching this repo's version-pinning convention. |
| 5 | Whether to add `@testing-library/jest-dom` (nicer matchers) alongside `@testing-library/react`/`jsdom` — this plan's sketch (§2.7) avoids depending on it, but it is a near-zero-risk, standard companion package and the Builder may add it if it makes the test file meaningfully more readable. | Builder's discretion — low-stakes either way. |

## 6. ADR-candidate flag

Not proposing a new ADR file — PRD §8.1/§10 already settle the "Vercel + a deployable Next.js shell" decision, and this ticket's job is to build the shell, not decide the platform.

One sub-decision is worth a future ADR pass's awareness without rising to "needs its own ADR file today":

- **Splitting sign-in/sign-out across two different Auth.js call surfaces — `@/auth`'s server-only actions (used in `app/layout.tsx`'s header) and `next-auth/react`'s client-only API (used in the sign-in page)** — forced by the Next.js Client/Server Component boundary (§0.3/§4), not a stylistic choice. If a future ticket (e.g. PLT-04's invite-code extension, or a later "sign out from any authenticated page, not just the header" feature) needs a THIRD sign-in/out entry point, whoever plans it should re-read §0.3/§2.1/§2.3 first rather than rediscover the constraint from a build failure. Not ADR-worthy today because it's a locally-contained, well-commented pattern with an easy escape hatch (either surface can always be used correctly once the Server/Client boundary is respected) — would only become ADR-worthy if a future ticket found both surfaces insufficient and needed to introduce a third, structurally different approach (e.g. a `SessionProvider`-based flow for a reason not yet foreseen).
