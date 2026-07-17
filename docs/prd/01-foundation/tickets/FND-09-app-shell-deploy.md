---
id: FND-09
title: App shell, sign-in page, and Vercel deploy pipeline
module: 01-foundation
lane: 01-foundation
size: S
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-01, FND-08]
blocks: []
---

# FND-09 — App shell, sign-in page, and Vercel deploy pipeline

No ADR — the decision is already made in PRD §10 P0 ("Vercel 部署流水线… 空应用在线") and §8.1 ("托管：自有硬件 → Vercel + Neon"); this is build ticket 9 of 10 against the `01-foundation` module, and the one that closes out P0's exit criteria.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-01 — Repo and toolchain bootstrap](FND-01-repo-toolchain-bootstrap.md), [FND-08 — Auth.js v5 and session/userId scoping helper](FND-08-authjs-session.md)
**Why `builder`:** producing a minimal deployable shell (root layout, landing page, sign-in page calling FND-08's already-built Auth.js) against fixed platform config, no open design.

## Background + basis

PRD §10 P0 row: "**P0 骨架** | repo、Auth.js、Drizzle schema、Vercel 部署流水线 | 注册/登录可用，空应用在线". This ticket is the one that makes the exit criteria literally true — everything else in `01-foundation` is prerequisite plumbing this ticket's shell surfaces.

PRD §8.1: "**托管：自有硬件 → Vercel + Neon。**…托管平台给出正确的可用性、TLS、备份与合规姿态，免费额度覆盖 v1。" — no self-hosting, no container config; Vercel's zero-config Next.js deployment is the target, meaning this ticket should need minimal/no custom `vercel.json` beyond what Next.js's own defaults handle.

FND-01 may have left a placeholder `app/layout.tsx`/`app/page.tsx` (per that ticket's Deliverable/Feedback note) — this ticket replaces their content, not their existence.

## Goal

A minimal but real app shell: root layout with sign-in/sign-out state awareness, a landing page, a working sign-in page (Google OAuth button + magic-link email form, both calling FND-08's `signIn()`), and Vercel-ready deployment config plus a CI deploy step — such that once Horace connects a real Vercel project (see Feedback obligation), the app is reachable at a public URL and a user can register/sign in.

## Non-goals

- No Jobs list, Library page, or any authenticated-app-page content — those are `03-library`/`04-fit`'s pages; this ticket's `app/(app)/**` footprint is limited to whatever minimal placeholder is needed to prove the auth-gated route group works (e.g. a one-line "you are signed in" placeholder page at `app/(app)/page.tsx`, explicitly noted as a placeholder later modules replace).
- No invite-code UI — `07-platform-launch`/PLT-04 appends an input field to the sign-in page this ticket creates (append-only, per `docs/prd/breakdown-plan.md` §3).
- No actual Vercel project creation, env var configuration, or domain binding — Horace's task (see Feedback obligation), same as flagged in FND-01/FND-05/FND-08.
- No `/admin` page — `07-platform-launch`/PLT-03.

## File-scope (write-owns)

- `app/layout.tsx`, `app/page.tsx`, `app/(auth)/signin/page.tsx`, `app/(app)/page.tsx` (minimal placeholder only, explicitly marked as such in a code comment for `03-library`/`04-fit` to replace)
- `vercel.json` (only if Next.js defaults are insufficient — prefer zero-config; if this ticket ends up NOT needing the file at all, that satisfies PRD §8.1's "无聊技术栈" spirit better than an unnecessary config file, and is an acceptable Deviation to record)
- `.github/workflows/ci.yml` — append a deploy step (Vercel CLI or Vercel's GitHub integration trigger) after the existing install/test/build steps FND-01 created — append-only.
- Does not touch: `app/(app)/library/**`, `app/(app)/jobs/**` (owned by `03-library`/`04-fit` onward), `app/(legal)/**`, `app/(admin)/**` (`07-platform-launch`).
- Serial-safety: FND-01 (creates the CI workflow and possibly a placeholder layout/page) and FND-08 (auth logic) are merged before this ticket starts; this ticket's edits to `app/layout.tsx`/`app/page.tsx` are a content replacement of FND-01's own placeholder, which FND-01's ticket explicitly anticipated (see that ticket's Deliverable 2/Feedback note) — no surprise collision. `.github/workflows/ci.yml`'s append here is the second touch after FND-01's creation, sequential, no in-flight contention.

## Deliverables

1. `app/layout.tsx` — root layout with `<html>`/`<body>`, minimal global styling (no design-system decision beyond what's needed to be legible — PRD does not specify a visual design system for v1, so keep this unstyled/minimally styled and defer any design-system choice to a future ticket if one becomes necessary), and a header showing sign-in state (calls `auth()` server-side; shows "Sign in" link to `/signin` when logged out, or a "Sign out" control calling FND-08's `signOut()` when logged in).
2. `app/page.tsx` — public landing page (minimal: product one-liner from PRD §0 "把求职者的真实经历（简历）解析成结构化背景库…" translated to an English UI string per PRD §5.8 "UI 英文", plus a call-to-action linking to `/signin`).
3. `app/(auth)/signin/page.tsx` — client component rendering a "Continue with Google" button (calls FND-08's `signIn('google')`) and a magic-link email form (calls FND-08's `signIn('resend', { email })`). Leaves a clearly marked insertion point (e.g. a named `<InviteCodeField />`-shaped comment or an optional prop) for `07-platform-launch`/PLT-04 to add an invite-code input without restructuring the page.
4. `app/(app)/page.tsx` — placeholder authenticated-area landing (e.g. "Signed in. Library and Jobs pages land in later modules." — literally that kind of explicit placeholder text so nobody mistakes it for a finished feature), inside the `middleware.ts`-protected route group FND-08 set up.
5. `.github/workflows/ci.yml` — append a `deploy` job (or step) that runs after `test`/`build` succeed on the default branch, invoking Vercel's deploy action/CLI — configured to no-op gracefully (log "no VERCEL_TOKEN configured, skipping deploy" and exit 0) when Vercel secrets aren't present, so CI doesn't hard-fail before Horace provisions the real Vercel project.

## Acceptance checklist (classified)

- [ ] `[machine]` `pnpm build` succeeds with the real (non-placeholder) `app/layout.tsx`/`app/page.tsx`/`app/(auth)/signin/page.tsx`/`app/(app)/page.tsx` in place.
- [ ] `[machine]` A component/integration test renders `app/(auth)/signin/page.tsx` and asserts both the Google button and the email form are present and call the expected `signIn()` arguments when triggered (mocking FND-08's `signIn`, not making real OAuth calls).
- [ ] `[machine]` `middleware.ts` (FND-08) correctly redirects an unauthenticated request to `/(app)` to `/signin` — integration test.
- [ ] `[machine]` `.github/workflows/ci.yml`'s deploy step no-ops (exits 0, does not fail the pipeline) when `VERCEL_TOKEN` is absent — verified by running the workflow's deploy step logic locally with the env var unset.
- [ ] `[machine]` `pnpm test` green.
- [ ] `[human]` Horace connects a real Vercel project, sets the real environment variables (`.env.example`'s full accumulated list from FND-01/05/06/08), and confirms `GET /` is reachable at a public URL and sign-in completes end to end — this is the literal "空应用在线" + "注册/登录可用" P0 exit criteria from PRD §10, and requires account access no agent has (see Feedback obligation).

## Test plan

Vitest + a component-testing setup (e.g. `@testing-library/react`, added as a dev dependency by this ticket if not already present — append to `package.json` per the foundation-owned-file convention, this ticket is itself part of `01-foundation` so it owns `package.json` directly, no append-only caveat needed here) for the sign-in page and layout auth-state rendering. Middleware redirect behavior tested via Next.js's own middleware testing utilities or a lightweight request-simulation test — no real network/OAuth calls in any test.

## Feedback obligation

1. General rule: this ticket is the last one in `01-foundation` and the one whose `[human]` acceptance item literally is the P0 milestone exit criteria — if any earlier FND ticket's deviation (recorded in its own Feedback notes) changes what this ticket needs to wire together, this ticket's Builder must read every prior FND ticket's actual merged Deviations note before starting, not just this ticket's own plan.
2. Real Vercel project creation, environment variable configuration (the full `.env.example` list accumulated across FND-01/05/06/08), and domain binding require Horace's account access — this is the terminal instance of the infra hand-off flagged in FND-01/FND-05/FND-08; once Horace completes it, the `[human]` acceptance item above is checked off and P0 is formally exited (per `docs/prd/breakdown-plan.md` §5's milestone mapping) — report this clearly as the blocking item if this ticket's automated portion is otherwise complete.
3. If Vercel's zero-config deployment turns out to need a `vercel.json` this ticket didn't anticipate (e.g. for the Neon connection pooling mode, or Auth.js's cookie settings under Vercel's edge runtime), add it here and record why in this ticket's changelog — don't let a later module (e.g. `04-fit`'s Anthropic API calls hitting a serverless timeout) discover and silently patch platform config that belongs to this ticket's scope.
