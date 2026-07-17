# Implementation plan — FND-01: Repo and toolchain bootstrap

Ticket: [docs/prd/01-foundation/tickets/FND-01-repo-toolchain-bootstrap.md](../prd/01-foundation/tickets/FND-01-repo-toolchain-bootstrap.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §8.1, §10 (P0 row)
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) §3

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified by directory listing at planning time: the repo contains only `CLAUDE.md`, `templates/`, `.claude/**`, `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md`, `docs/**` (PRD, ADR/plans placeholders, prd tickets). No `package.json`, no `app/`, no `lib/`, no `.github/workflows/`. Local tool probe: Node `v22.11.0` and Corepack `0.29.4` are present in the dev/CI-equivalent environment; `pnpm` is **not** installed by default (must be enabled via Corepack or `pnpm/action-setup`); `actionlint` is **not** installed (confirms the ticket's own fallback — manual YAML parse — is the one to use, not an assumed tool). Before writing any file, the Builder should re-run this same listing (`git status`, `ls -a`) to confirm no other ticket landed first — this ticket has no `blocked_by`, so it should be the first merge into `main`.

## 1. Scope

**In scope** — a Next.js 15 App Router + TypeScript project scaffold at the repo root:
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next.config.mjs`, `.gitignore`, `.env.example`, `vitest.config.ts`
- `.github/workflows/ci.yml` (install → test → build)
- `tests/smoke.test.ts`
- Placeholder `app/layout.tsx` / `app/page.tsx` **only if** `next build` fails without at least one route (verify empirically — see §2.8; do not add speculatively)

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):
- Auth.js config (`auth.ts`, `middleware.ts`, `lib/auth/**`, `app/api/auth/**`) — FND-08
- Drizzle/DB setup (`db/**`) — FND-05
- Zod schemas (`lib/schemas/**`) — FND-02/03/04
- Real Vercel project creation, env var configuration, domain binding — requires Horace's account access, tracked as open question #2 in the sub-PRD README, owner Horace
- Any application page content beyond a minimal placeholder needed for `next build` to succeed — FND-09 owns real `app/layout.tsx`/`app/page.tsx` content
- ESLint/Prettier style-rule decisions beyond what `next lint`'s own default config requires to run

## 2. Change list

All paths are new files (greenfield repo — no edits to existing files except this ticket does not touch any existing tracked file at all; `CLAUDE.md`, `templates/`, `.claude/**`, `docs/**` are untouched).

### 2.1 `package.json` (new)

- `"name"`: repo-appropriate slug (e.g. `groundwork`), `"version": "0.1.0"`, `"private": true`.
- `"packageManager": "pnpm@<exact-version>"` — resolve the exact version at implementation time via `corepack use pnpm@latest` (or pin to the latest pnpm 9.x/10.x stable at build time; do not hand-guess a version string that Corepack hasn't actually resolved, since a mismatched pin makes `corepack enable` fail). Confirm the resolved version by running `pnpm --version` after `corepack use` and copying that exact string into the field.
- `"engines": { "node": ">=20" }` — advisory only (does not block install), documents the minimum Next.js 15 needs (Next 15 requires Node >=18.18; this repo pins 20+ because Node 20 reaches its own EOL around April 2026 and CI should already be on a maintained line — see §2.7 for the CI runtime pin).
- `"scripts"`:
  - `"dev": "next dev"`
  - `"build": "next build"`
  - `"start": "next start"`
  - `"test": "vitest run"` — this is the "project test-suite command" every other ticket's acceptance checklist references; do not rename it.
  - `"lint": "next lint"`
- `"dependencies"`: `next` (`^15.x`, latest 15 minor at implementation time), `react` (`^19.x` — Next 15 requires React 19), `react-dom` (`^19.x`).
- `"devDependencies"`: `typescript`, `@types/react`, `@types/node`, `vitest`, plus **two packages the ticket's Deliverable-1 dependency list does not name but that are required for the `lint` script it does request to actually run**: `eslint` and `eslint-config-next`. Rationale: `next lint` is inert without them; Next.js's own `create-next-app` always adds these when scaffolding the default lint setup. This is not a style-rule decision (no non-default rules are added) and does not touch File-scope owned elsewhere — it is the minimum needed to make the explicitly-requested `"lint"` script functional. Record this as a one-line deviation note in the ticket's Feedback-obligation writeback (§4 below) so it's traceable, not silent.
  - Do **not** add `@types/react-dom` unless `create-next-app`'s current default template does (verify at implementation time — recent Next.js versions have folded this into `@types/react` in some setups; check the actual peer-dependency warning from `pnpm install`, don't guess).
- Do not add any other dependency (no Zod, no Drizzle, no Auth.js, no mammoth) — those belong to later tickets and append to this file per the breakdown plan's file-ownership table (§3, row 1): "`03`–`07` 的任何票据如需新依赖，只能追加 `dependencies`/`scripts` 字段，不得重写" (any later ticket needing a new dependency may only append `dependencies`/`scripts` fields, never rewrite this file).

### 2.2 `tsconfig.json` (new)

- `"compilerOptions"`: `"strict": true`, `"target": "ES2017"` (or newer per current `create-next-app` default — verify), `"module": "esnext"`, `"moduleResolution": "bundler"`, `"jsx": "preserve"`, `"esModuleInterop": true`, `"resolveJsonModule": true`, `"isolatedModules": true`, `"incremental": true`, `"plugins": [{ "name": "next" }]`.
- `"paths": { "@/*": ["./*"] }` — repo-root alias, per Deliverable 2, so `lib/schemas/...` etc. resolve as `@/lib/schemas/...` for every downstream ticket.
- `"include"`: `["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "tests/**/*.ts"]`.
- `"exclude"`: `["node_modules"]`.

### 2.3 `next.config.mjs` (new)

Minimal — no custom webpack/experimental/`output` flags (PRD names no exception; Non-goals explicitly forbid inventing config):

```js
/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
```

### 2.4 `vitest.config.ts` (new)

Node environment (no jsdom — no client-component tests exist yet), scoped to `tests/**`, **and** the repo-root path alias mirrored from `tsconfig.json`. This alias mirroring is load-bearing, not cosmetic: `next build`/`next dev` resolve `@/*` automatically from `tsconfig.json` via the Next.js SWC/webpack plugin, but Vitest does **not** read `tsconfig.json` paths on its own — it needs either an explicit `resolve.alias` entry or the `vite-tsconfig-paths` plugin. `vitest.config.ts` is a shared, append-only file per the breakdown plan (§3: `03`–`07` and `02-evaluation` may only append, never rewrite it) and FND-07 (server validation layer tests) and later tickets will `import` from `@/lib/...` in their Vitest test files. If the alias isn't wired now, the first downstream ticket to write a Vitest test importing `@/...` either breaks or is forced to violate append-only by restructuring this file — get it right in this ticket.

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
```

(Using a plain `resolve.alias` rather than pulling in `vite-tsconfig-paths` as a new dependency keeps Deliverable 1's dependency list minimal — no new package needed for this.)

### 2.5 `tests/smoke.test.ts` (new)

```ts
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('proves the pnpm test command runs end to end', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Per Deliverable 5, do not delete this file in this ticket even after other files exist; downstream tickets add real tests alongside their own code.

### 2.6 `.env.example` (new)

Exactly the seven keys named in Deliverable 7, blank/placeholder values, no real secrets:

```
ANTHROPIC_API_KEY=
DATABASE_URL=
AUTH_SECRET=
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
```

This file is append-only for later tickets (FND-06's daily spend threshold, PLT-02's R2 credentials per the ticket's own Deliverable-7 note) — do not add keys beyond what P0 needs (the seven above), let later tickets append their own.

### 2.7 `.github/workflows/ci.yml` (new)

Triggers: `push` and `pull_request`. Steps, in this exact order (the acceptance checklist requires install → test → build as the checked ordering; the setup steps below are prerequisites, not part of that ordering claim):

1. `actions/checkout@v4`
2. `pnpm/action-setup@v4` — do this **before** `actions/setup-node`, since `setup-node`'s `cache: 'pnpm'` option needs `pnpm` already on `PATH` to compute the cache key. Pin the version to match `package.json`'s `packageManager` field (or omit `version` and let it read `packageManager` automatically — `pnpm/action-setup@v4` supports this; prefer that over hand-duplicating the version string in two places).
3. `actions/setup-node@v4` with `node-version: '22'` (or the current Active/Maintenance LTS at implementation time — Node 20 reaches end-of-life ~April 2026; verify the current Node release schedule at implementation time rather than trusting this plan's date-anchored claim, since plans can go stale) and `cache: 'pnpm'`.
4. `run: pnpm install --frozen-lockfile`
5. `run: pnpm test`
6. `run: pnpm build`

Do not add a separate `lint` CI step — the ticket's Deliverable 6 lists exactly install/test/build as CI steps; `pnpm lint` is a local/PR-hygiene script, not a ticket-mandated CI gate (adding one would be scope creep beyond Deliverable 6's explicit step list — if desired later, that's a call for whichever ticket next touches `ci.yml`, since it's append-only from here).

### 2.8 Placeholder `app/layout.tsx` / `app/page.tsx` — conditional, verify empirically

Next.js 15's App Router build fails without a root layout and at least one page. Expect this to be needed, but **confirm empirically** (`pnpm build` with no `app/` directory first) rather than assuming — the ticket explicitly frames this as conditional ("ONLY if next build requires at least one route to succeed").

If required, both files get a leading placeholder-ownership comment per the ticket's Feedback obligation #2, so FND-09's Builder isn't surprised by a pre-existing file:

`app/layout.tsx`:
```tsx
// FND-09 replaces this — see docs/prd/01-foundation/tickets/FND-09-app-shell-deploy.md
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`app/page.tsx`:
```tsx
// FND-09 replaces this — see docs/prd/01-foundation/tickets/FND-09-app-shell-deploy.md
export default function Home() {
  return null;
}
```

Both are placeholder-only per Non-goals (no landing content). State explicitly in the commit message that these are placeholders FND-09 will overwrite, per the ticket's own instruction.

### 2.9 `.gitignore` (new)

Deliverable 8's floor is `node_modules`, `.next`, `.env`, `.env.local`. Since this is "scaffolding equivalent to `create-next-app` defaults" (per ticket's Non-goals framing) and inventing a narrower list than the standard template risks committing build artifacts (`next-env.d.ts` is auto-generated by `next dev`/`next build` and is conventionally ignored; `*.tsbuildinfo` likewise), use the standard Next.js template's `.gitignore` content as the superset — this is not a style-rule invention, it's the mechanical default that ships with every Next.js scaffold:

```
# dependencies
/node_modules

# testing
/coverage

# next.js
/.next/
/out/

# production
/build

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# env files
.env
.env*.local

# vercel
.vercel

# typescript
*.tsbuildinfo
next-env.d.ts
```

### 2.10 `pnpm-lock.yaml`

Generated artifact of `pnpm install` — do not hand-author. Must be committed (CI uses `--frozen-lockfile`).

## 3. Test plan

Maps directly to the ticket's acceptance checklist; each item below is what the Builder/Reviewer actually runs.

1. **`pnpm install` succeeds on a clean checkout** — from a fresh scratch clone (not the working tree with `node_modules` already present), run `corepack enable && pnpm install`. Exit code 0, no error beyond expected registry/network access. Proves Deliverable 1's dependency set resolves and the `packageManager` pin is consistent with what Corepack actually installs.
2. **`pnpm test` runs Vitest and the smoke test passes** — `pnpm test` exits 0 with 1 passed test (`tests/smoke.test.ts`). This is the standing "project test-suite command" acceptance item every other ticket in the repo references — verify the command name (`pnpm test`, not `pnpm run test:unit` or similar) matches exactly what downstream ticket files already assume (they say `pnpm test`).
3. **`pnpm build` succeeds** — `pnpm build` exits 0. If `app/` placeholder files were needed per §2.8, this is where that gets proven; if not needed, confirm the build still succeeds with an explicit note in the deviation log that no placeholder route was required (falsifies the ticket's default assumption — record per Feedback obligation #2, don't just silently skip the files).
4. **`.github/workflows/ci.yml` is valid YAML with steps in install → test → build order** — since `actionlint` is not available in this environment (confirmed at planning time), use the ticket's own stated fallback: manual YAML parse, e.g. `node -e "console.log(require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')))"` (requires the `yaml` npm package — use `npx yaml-lint` or Node's not-yet-stable YAML support, or simply `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` if Python/PyYAML is available; either way, parse without throwing, then eyeball/`grep` the `run:` step order for `pnpm install`, `pnpm test`, `pnpm build` in that sequence). If `actionlint` happens to be installable in the Builder's actual environment, prefer it — the ticket names it as the primary check.
5. **`.env.example` contains no real secret values** — `grep -E '=.+' .env.example` should return no matches (every line is `KEY=` with nothing after `=`); if any value is non-empty, manually confirm it's an obvious placeholder, not a live credential.
6. **No file outside File-scope was touched** — `git diff --stat <base-commit>..HEAD` (base = the commit at repo state described in §0) lists only the files enumerated in §2 above plus `pnpm-lock.yaml`. Any other path in the diff is a File-scope violation and must be reverted before merge.
7. **CI actually runs green on the PR** — once pushed, confirm the GitHub Actions run for `ci.yml` completes with all steps green on the actual GitHub-hosted runner (this is the one check that cannot be fully validated locally, since it depends on the real Actions runner image's Node/pnpm availability — this is exactly the risk the ticket's Feedback obligation #1 anticipates).

All of the above (1–6) are reproducible fully offline except step 7, which needs GitHub's runner but touches no external service (DB, Anthropic API) — consistent with the ticket's own Test plan §1 framing.

## 4. Risks & edge cases

- **CI runner Node/pnpm availability (explicitly anticipated by the ticket's Feedback obligation #1).** GitHub's `ubuntu-latest` image ships a Node.js version and Corepack, but Corepack's own future in Node distributions has been in flux (signaled for removal/opt-in-only in some upstream Node roadmap discussions) — if `corepack enable` fails or is unavailable on the runner, fall back to `pnpm/action-setup@v4`, which vendors its own pnpm binary independent of Corepack. If Node's default LTS on the runner conflicts with Next 15's minimum (`>=18.18`), that would be a genuine ticket-blocking finding — per the ticket's own instruction, do **not** silently swap to npm/yarn; update the ticket file (version +0.1) and `01-foundation/README.md` changelog with the corrected toolchain choice first, then proceed.
- **`vitest.config.ts` alias drift from `tsconfig.json`.** Both files declare `@/*` → repo root independently (Vitest doesn't read `tsconfig.json` paths automatically). If a future ticket changes one without the other, imports silently diverge between `next build` and `pnpm test` (code compiles under one, fails under the other). Not this ticket's bug to prevent structurally, but worth flagging to the Reviewer as a drift risk to watch for in every subsequent ticket that touches either file.
- **`packageManager` version pin vs. actual CI-resolved pnpm version.** If the Builder hand-writes a `pnpm@x.y.z` string without actually running `corepack use pnpm@latest` and reading back the resolved version, `corepack enable` in CI can fail with a checksum/signature mismatch, breaking every downstream ticket's CI run (this file is the one every other ticket depends on being green). Verify the exact string was read back from a real `pnpm --version` invocation, not typed from memory.
- **Placeholder route content colliding with FND-09.** If `app/layout.tsx`/`app/page.tsx` are created here and FND-09 doesn't realize they're placeholders (e.g. the inline comment is missed or stripped), FND-09's Builder could either silently leave stale content in `<html>`/`<body>` structure or be confused about whether it's creating vs. overwriting. Mitigated by the explicit `// FND-09 replaces this` comment (§2.8) and by stating it plainly in the commit message — both are required, not optional.
- **Concurrency / security-sensitive paths: none apply to this ticket.** This is pure static toolchain scaffolding — no runtime request handling, no database access, no auth, no secrets beyond `.env.example` placeholders (which by construction hold no real values, checked by acceptance item 5 / test-plan item 5 above). There is no concurrent-write surface: this is the first ticket into a greenfield repo with no other in-flight ticket contending for any of its files (confirmed in §0). The one adjacent security-relevant property worth the Reviewer double-checking is purely negative: confirm `.gitignore` actually covers `.env`/`.env.local` (§2.9) so a Builder's real local secrets, if any exist during development, can never be accidentally `git add`ed — this is a preventive control, not a runtime one.
- **`eslint`/`eslint-config-next` addition (§2.1) is a plan-level judgment call, not literally itemized in the ticket's Deliverable-1 dependency list.** Flagged explicitly so the Reviewer checks it deliberately rather than treating it as scope creep: it is required for the ticket's own explicitly-requested `"lint"` script to function at all, adds no non-default style rules, and touches no file outside `package.json` (already in File-scope).

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Exact `next`/`react`/`typescript`/`vitest` minor/patch versions to pin — this plan specifies major versions only (`next@15`, `react@19`) per PRD §8.1's pin and leaves exact resolution to whatever is latest-stable at implementation time. | Builder, at implementation time — record the resolved versions in the deviation log per the ticket's general Feedback-obligation rule (no re-review needed, this is normal scaffolding variance, not a spec change). |
| 2 | Whether `app/layout.tsx`/`app/page.tsx` placeholders are actually needed for `next build` to succeed (§2.8) — this plan expects yes but instructs empirical verification rather than assuming. | Builder — verify by attempting `pnpm build` before deciding; if not needed, note the deviation from the ticket's default assumption per Feedback obligation #2. |
| 3 | Exact CI runner Node LTS version to pin (this plan suggests Node 22, reasoning from Node's release schedule as of the planning date) — release schedules move; the Builder should check the current Node.js LTS status at implementation time rather than trust this plan's dated claim. | Builder, at implementation time. |
| 4 | Real Vercel project creation / env var configuration / domain binding — explicitly out of this ticket's scope (no agent account access). | Horace — already tracked as open question #2 in `docs/prd/01-foundation/README.md`; no new tracking needed from this ticket. |

## ADR-candidate flag

None of the choices in this plan rise to ADR-worthy (hard-to-reverse architectural decision) status — the stack itself (Next.js 15 / TypeScript / pnpm / Vitest / GitHub Actions) is already pinned by PRD §8.1, and every implementation-level choice here (exact Node LTS line, exact pnpm patch version, `.gitignore` contents, Vitest alias wiring) is cheaply reversible by a later ticket appending to these shared files. No ADR is proposed by this plan.
