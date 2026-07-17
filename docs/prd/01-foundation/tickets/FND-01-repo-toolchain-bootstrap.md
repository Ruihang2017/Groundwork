---
id: FND-01
title: Repo and toolchain bootstrap
module: 01-foundation
lane: 01-foundation
size: S
agent: builder
status: draft
version: 0.2
date: 2026-07-18
blocked_by: []
blocks: [FND-02, FND-03, FND-06, FND-09]
---

# FND-01 — Repo and toolchain bootstrap

No ADR — the decision is already made in PRD §8.1 ("Next.js 15 (App Router) + TypeScript + Zod v4 + Drizzle + Neon Postgres + Auth.js v5 … + Vercel + Anthropic Messages API"); this is build ticket 1 of 10 against the `01-foundation` module.
Parent sub-PRD: [01-foundation README](../README.md). Master spec: [PRD](../../../PRD.md).
**Why `builder`:** scaffolding a new Next.js project from a documented stack decision is mechanical, not a design choice — no exploration of existing code is possible (greenfield repo).

## Background + basis

PRD §8.1 pins the stack: "**Next.js 15 (App Router) + TypeScript + Zod v4 + Drizzle + Neon Postgres + Auth.js v5（Google OAuth + email magic link via Resend）+ Vercel + Anthropic Messages API（pin `claude-sonnet-5`）。**" PRD §10 P0 lists the exit criteria this bootstrap serves: "repo、Auth.js、Drizzle schema、Vercel 部署流水线 … 注册/登录可用，空应用在线". This ticket delivers only the repo/toolchain shell — Auth.js is FND-08, Drizzle schema is FND-05, the deployable app shell is FND-09.

Repo state at the start of this ticket: only `CLAUDE.md`, `templates/`, `.claude/`, `docs/adr/.gitkeep`, `docs/plans/.gitkeep`, `docs/prd/**` exist. No `package.json`, no `app/` directory, no production code of any kind.

This repo's `templates/ticket.template.md` requires every ticket's acceptance checklist to include "`[machine]` <project test-suite command> green" (line 85 of the template). This ticket is the one that creates that command — every other ticket in every module references it, so it must exist and pass on an empty/trivial test before any other ticket starts.

## Goal

A Next.js 15 App Router + TypeScript project scaffold at the repo root, installable with `pnpm install`, buildable with `pnpm build`, with a working `pnpm test` command (Vitest) that passes on a trivial smoke test, and a GitHub Actions CI workflow that runs install → test → build on every push/PR. Package manager is `pnpm` (matches PRD §6's own reference to `pnpm eval`).

## Non-goals

- No Auth.js configuration — FND-08.
- No Drizzle/DB setup — FND-05.
- No Zod schemas — FND-02/03/04.
- No actual Vercel project creation or deployment — that requires Horace's account access (see Feedback obligation); this ticket only produces the Vercel-compatible project structure and config file.
- No application pages beyond what `create-next-app`-equivalent scaffolding produces by default (no landing page content) — FND-09 owns `app/layout.tsx`/`app/page.tsx` content.
- No ESLint/Prettier policy decisions beyond Next.js defaults — not specified in PRD, keep default config, do not invent style rules.

## File-scope (write-owns)

- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next.config.mjs`, `.gitignore`, `.env.example` (create with placeholder keys only, no real secrets), `vitest.config.ts`, `.github/workflows/ci.yml`, `tests/smoke.test.ts`
- Minimal placeholder `app/layout.tsx` / `app/page.tsx` ONLY if `next build` requires at least one route to succeed — if created here, they are placeholder-only (e.g. return `null`/plain text) and FND-09 replaces their content; state this explicitly in your commit so FND-09's Builder knows it is overwriting, not creating.
- Does not touch: any file under `lib/`, `db/`, `auth.ts`, `app/api/**`, `app/(app)/**`, `app/(auth)/**` beyond the placeholder noted above — those belong to later foundation tickets and downstream modules.
- Serial-safety: greenfield repo, no prior touches to any of these paths, no in-flight ticket contends for them (this is the first ticket in the first module).

## Deliverables

1. `package.json` with `"packageManager": "pnpm@<version>"`, scripts `"dev"`, `"build"`, `"start"`, `"test": "vitest run"`, `"lint"` (Next.js default lint script). Dependencies: `next@15`, `react`, `react-dom`, `typescript`, `@types/react`, `@types/node`. Dev dependency: `vitest`. This file is the one other modules append `dependencies`/`scripts` entries to per `docs/prd/breakdown-plan.md` §7 — do not add any dependency here that isn't needed for the bootstrap itself.
2. `tsconfig.json` with `strict: true` and the Next.js App Router path-alias convention (`@/*` → repo root), so downstream `lib/schemas/**` etc. can be imported as `@/lib/schemas/...`.
3. `next.config.mjs` — minimal, no custom webpack/experimental flags unless required to build; if Vercel deployment needs specific config (e.g. `output` mode), leave Next.js defaults since PRD names no exception.
4. `vitest.config.ts` configured for the App Router TS project (node environment is sufficient — no jsdom needed yet since no client-component tests exist in this ticket).
5. `tests/smoke.test.ts` — one trivial passing assertion (e.g. `expect(1 + 1).toBe(2)`) that exists solely to prove the `pnpm test` command works end to end. Downstream tickets add real tests alongside their own code; this file may be deleted once real tests exist, at the Builder's discretion in a later ticket — do not delete it in this ticket.
6. `.github/workflows/ci.yml` — GitHub Actions workflow triggered on `push` and `pull_request`, steps: checkout, setup pnpm, setup Node (LTS matching Next.js 15's supported range), `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build`.
7. `.env.example` listing the env var names known to be needed by the end of P0 (from PRD §8.1/§8.3): `ANTHROPIC_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` — values left blank/placeholder, never real secrets. Later tickets append new keys as needed (e.g. FND-06's daily spend threshold, PLT-02's R2 credentials) — this file is one of the append-only shared files per the breakdown plan.
8. `.gitignore` covering `node_modules`, `.next`, `.env`, `.env.local`.

## Acceptance checklist (classified)

- [ ] `[machine]` `pnpm install` succeeds on a clean checkout with no network errors beyond registry access.
- [ ] `[machine]` `pnpm build` succeeds (empty/placeholder app compiles).
- [ ] `[machine]` `pnpm test` runs Vitest and the smoke test passes — this IS the "project test-suite command" that every other ticket in this repo references as its standing suite-green acceptance item.
- [ ] `[machine]` `.github/workflows/ci.yml` is valid YAML and its steps are `install → test → build` in that order (checked via `actionlint` if available, otherwise manual YAML parse in the test plan).
- [ ] `[machine]` `.env.example` contains no real secret values (grep for obviously non-placeholder values — CI-checkable via a simple script or manual review).
- No `[human]` criteria — pure toolchain setup, nothing requires subjective judgment.

## Test plan

1. Fresh clone into a scratch directory, run `pnpm install && pnpm test && pnpm build` — all three must exit 0. This is the reproducible-offline check; no external services (DB, Anthropic API) are touched by this ticket, so it needs no mocks or fixtures.
2. Validate `.github/workflows/ci.yml` parses as YAML (`node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"` or equivalent) and lists the three required steps in order.
3. Confirm no other files outside this ticket's File-scope were touched (`git diff --stat` against the base commit).

## Feedback obligation

1. General rule: if `pnpm` turns out to be unavailable/unsuitable in the actual CI runner image, or Next.js 15's supported Node range conflicts with the CI image default, update this ticket file (version +0.1, changelog line in `01-foundation/README.md`) with the corrected toolchain choice before proceeding — do not silently swap to npm/yarn.
2. If `next build` requires more than a placeholder route to succeed (e.g. Next.js 15 refuses to build with zero pages), and the placeholder page/layout you add conflicts with what FND-09 later needs to build, leave an explicit inline comment in the placeholder file (`// FND-09 replaces this — see docs/prd/01-foundation/tickets/FND-09-*.md`) so FND-09's Builder isn't surprised by an existing file with unexpected content.
3. Real Vercel project creation, environment variable configuration, and domain binding are **not part of this ticket** and cannot be done by an agent (no account access) — this is carried forward as open question #2 in `01-foundation/README.md`, owner Horace. Do not attempt to use CLI tools that assume an authenticated Vercel session; if `vercel` CLI commands are attempted and fail for lack of auth, that is expected, not a ticket failure — report it as a Deviation, not a blocker.

## Changelog

- **v0.2 (2026-07-18)** — Feedback-obligation #1 writeback: corrected **local** toolchain provisioning. The plan's §3.1 command (`corepack enable && pnpm install`) does **not** work on the reference dev environment (Node `22.11.0` / Corepack `0.29.4`): Corepack aborts with `Error: Cannot find matching keyid` because its bundled npm-registry signing keys predate the registry's key rotation and cannot verify the pinned `pnpm@10.34.5`. Corrected local provisioning — use **either**: (a) a newer Node/Corepack whose bundled keys include the rotated set, **or** (b) a standalone pnpm bypassing Corepack — `npm install -g pnpm@10.34.5`, or set `COREPACK_INTEGRITY_KEYS=0` for a one-shot Corepack provision. **CI is unaffected**: `.github/workflows/ci.yml` provisions pnpm via `pnpm/action-setup@v4`, which vendors the pnpm binary directly and never invokes Corepack — so the scaffold (`package.json` pin, lockfile, `ci.yml`) is correct and unchanged; only this documentation writeback was owed. Regression guard added at `tests/toolchain.test.ts`. Mirror changelog line added to `01-foundation/README.md`.
- **v0.1 (2026-07-17)** — Initial draft, generated with the sub-PRD via `/breakdown-prd`.
