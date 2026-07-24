---
id: ISS-32
title: Add Gate 2 smoke-test runbook (docs/ops/gate2-smoke-test.md)
module: 99-nightly
lane: 99-nightly
size: S
agent: builder
status: draft
date: 2026-07-24
blocked_by: []
blocks: []
---

# ISS-32 — Add Gate 2 smoke-test runbook (docs/ops/gate2-smoke-test.md)

Sourced from tracker issue #42 ("Add Gate 2 smoke-test runbook (docs/ops/gate2-smoke-test.md) consolidating all [human] acceptance items"), triaged via the nightly sweep. Not part of any feature PRD module — `99-nightly` is the pipeline's own bucket for maintenance/bug tickets synthesized from tracker issues outside an existing sub-PRD's scope, per `.claude/agents/triage.md` ("write a ticket file at `docs/prd/99-nightly/tickets/ISS-<number>-<slug>.md`"). No parent sub-PRD README exists for this module (it is not a product feature area); the master spec `docs/PRD.md` is not implicated as a design source here — this is a documentation-only addition consolidating already-decided acceptance items, not a product-behavior change.
**Why `builder`:** the issue body already contains the full, orchestrator-verified content spec for the doc (every section, every env var, every `[human]` citation) — the Builder writes essentially that content verbatim into a new file. There is no design judgment left to make; a Reviewer pass checking accuracy against the ticket set is sufficient, no Architect planning step is needed for what to say.

## Background + basis

Issue #42 body (verbatim), reproduced and independently re-verified by the triage stage before writing this ticket (verification notes follow the quote):

> ## Symptom / Need
>
> The full 28-ticket PRD is delivered (all issues closed, `main` green: 104 files / 1239 tests). The only remaining gate is the **human Gate 2 smoke test** — an end-to-end pass through the delivered product with real credentials. There is currently no single checklist that consolidates the scattered `[human]` acceptance items into an actionable, checkable runbook.
>
> ## Goal
>
> Add `docs/ops/gate2-smoke-test.md` — a step-by-step Gate 2 smoke-test runbook that consolidates every `[human]` acceptance item across the 28 tickets into one funnel-ordered, checkbox-driven document Horace can follow and tick off, and record findings in.
>
> ## Authoritative content (write essentially verbatim; the orchestrator already derived and verified it against the tickets)
>
> The doc must contain these sections, in order, as GitHub-flavored markdown with `- [ ]` checkboxes for every actionable step:
>
> ### Phase 0 — Credential provisioning (one-time)
> Env vars (from `.env.example`, verified): `ANTHROPIC_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `GLOBAL_DAILY_SPEND_LIMIT_USD`, `ADMIN_EMAILS`.
> - Where each comes from: Neon (DATABASE_URL — MUST use the direct/unpooled endpoint, not `-pooler`, per PLT-02), Anthropic console, Google Cloud OAuth client (Web), Resend (key + verified sending domain), `npx auth secret` for AUTH_SECRET, self-chosen spend limit, own email(s) for ADMIN_EMAILS.
> - SECURITY: real secrets go only into Vercel env panel or a gitignored `.env.local` — never committed, never pasted into chat.
> - FND-05 [human]: run `corepack pnpm db:migrate` against real Neon once (expect migrations 0000–0004 applied).
> - FND-09 [human] = P0 exit: import repo to Vercel, set all 9 env vars, deploy, add Google callback `https://<domain>/api/auth/callback/google`.
>
> ### Phase 1 — Auth + app shell (FND-08/09)
> - [ ] `/` reachable at public URL (FND-09 [human], "空应用在线")
> - [ ] Google OAuth sign-in end-to-end (FND-08 [human])
> - [ ] Resend magic-link sign-in end-to-end (FND-08 [human])
> - Note: 1.1 + a sign-in = **P0 formally exited**.
>
> ### Phase 2 — Library (LIB, P1)
> - [ ] Upload a real resume PDF → PARSE → confirm UI (LIB-01)
> - [ ] Upload an empty-metrics resume → judge the "红字盘点" banner is legible/prominent enough (LIB-03 [human]); tweak in `app/(app)/library/_components/` + log in `03-library/README.md` if not.
> - [ ] Save → Library page shows it (LIB-02/03)
>
> ### Phase 3 — Fit report (FIT, P2)
> - [ ] Paste real JD → create job/READ (FIT-01)
> - [ ] Trigger CROSS + SCORE (FIT-02)
> - [ ] Open Fit Report → judge legibility + disclaimer clarity (FIT-03 [human], P2 dogfood)
>
> ### Phase 4 — Tailor (TLR, P3)
> - [ ] Trigger TAILOR → alignment table + edits (TLR-01)
> - [ ] Review/edit, export PDF (TLR-02)
> - [ ] Print/export the PDF → judge against PRD §13 Q2 "可直接投递" bar (TLR-02 [human]). If insufficient: do NOT hand-patch — record specifics in `05-tailor/README.md` open question #1, which triggers a separate template-engine ticket (PRD's stated fallback "不行则提前引入模板").
>
> ### Phase 5 — Prep (PRP, P4)
> - [ ] Prep tab locked until job.status === 'interviewing', unlocks after (PRP-03)
> - [ ] Push status to interviewing → RESEARCH (PRP-01)
> - [ ] REHEARSE (PRP-02)
> - [ ] Generate + read a real Brief end-to-end (PRP-04 [human], P4 exit "一个真实 job 全漏斗走通")
>
> ### Phase 6 — Platform + compliance (PLT, P5)
> - [ ] Review `/privacy` and `/tos` for legal adequacy before public launch (PLT-01 [human]). Behavior mismatch = P0 code fix + escalate; copy-only = edit + log in `07-platform-launch/README.md`.
> - [ ] Allowlisted email sees `/admin` aggregates; non-allowlisted → 403 (PLT-03)
> - [ ] `node scripts/generate-invite-codes.mjs --count 5` (against real DB) → register with one code, confirm gate (PLT-04)
> - [ ] Account delete: settings → delete → all per-user rows hard-deleted, signed out (PLT-01)
> - [ ] (optional, pre-P5) Backup: provision Cloudflare R2 + 5 GitHub Actions secrets (DATABASE_URL direct endpoint, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT); Actions → Weekly backup → Run workflow; confirm a non-empty .sql.gz in R2; record the working Neon endpoint back into docs/ops/backup.md (PLT-02 [human]).
>
> ### Wrap-up section
> - Each ⚠️ judgment item (4.3 export fidelity, 6.1 legal) does NOT block ticket delivery — it routes to its README's escalation/record path.
> - Any code bug found → open a GitHub issue → three-agent pipeline fix (same as ISS-29/30/31).
> - All phases pass ⇒ P0–P5 milestones formally exited; project is release-ready.
> - Suggested start: Phase 0 + Phase 1 first (locks P0), then 2→6 in funnel order.
>
> ## File-scope (write-owns)
>
> - `docs/ops/gate2-smoke-test.md` (new)
> - Does NOT touch any source, test, other docs, or ticket files. Pure documentation addition.
>
> ## Acceptance
>
> - [ ] `[machine]` `docs/ops/gate2-smoke-test.md` exists, is valid GFM, and every actionable step is a `- [ ]` checkbox.
> - [ ] `[machine]` Every env var named matches `.env.example` exactly (no invented vars); the DATABASE_URL direct-endpoint caveat is present.
> - [ ] `[machine]` Each phase cites its ticket ids; every `[human]` item from FND-05/08/09, LIB-03, FIT-03, TLR-02, PRP-04, PLT-01, PLT-02 appears exactly once.
> - [ ] `[machine]` `corepack pnpm test` stays green (doc-only change touches no code).
> - [ ] No `[human]` criteria — this is a documentation artifact, mechanically checkable against the ticket set.
>
> ## Non-goals
>
> - No changes to product code, tests, or existing docs. No new tooling. This is a runbook, not automation.

Triage-stage verification performed this session (facts this ticket relies on beyond the issue text — re-verified directly against the repo, not accepted from the issue alone, per `.claude/agents/triage.md`'s "read the code to verify claims before classifying"):

- **Env var list is exact.** `.env.example` (15 lines of app-runtime vars, read in full) lists precisely these 9 keys and no others: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `GLOBAL_DAILY_SPEND_LIMIT_USD`, `ADMIN_EMAILS` — byte-for-byte the issue's Phase 0 list. The file's remaining lines (17-28) are a commented-out block of four `R2_*` names explicitly labelled "GitHub Actions repository secrets... do NOT belong in .env.local" — correctly excluded from Phase 0 (app runtime vars) and instead referenced only in Phase 6's backup item, matching the issue's own placement.
- **Every `[human]` citation is real and present exactly once in its named ticket**, confirmed via `grep -rn "\[human\]" docs/prd`:
  - `docs/prd/01-foundation/tickets/FND-05-drizzle-schema-neon.md:74` — Neon `DATABASE_URL` provisioning + `pnpm db:migrate` run.
  - `docs/prd/01-foundation/tickets/FND-08-authjs-session.md:65` — real Google OAuth client + Resend account/key, confirm sign-in end-to-end.
  - `docs/prd/01-foundation/tickets/FND-09-app-shell-deploy.md:63` — real Vercel project, env vars, `GET /` reachable + sign-in end-to-end (the literal P0 exit).
  - `docs/prd/03-library/tickets/LIB-03-confirm-ui-library-page.md:67` — empty-metrics "红字" banner legibility judgment.
  - `docs/prd/04-fit/tickets/FIT-03-jobs-list-fit-report-ui.md:72` — Fit Report legibility/disclaimer dogfood judgment.
  - `docs/prd/05-tailor/tickets/TLR-02-alignment-ui-export.md:70` — exported PDF vs. PRD §13 Q2 "可直接投递" bar.
  - `docs/prd/06-prep/tickets/PRP-04-brief-content-ui.md:66` — real Brief generate+review, P4 "一个真实 job 全漏斗走通" exit.
  - `docs/prd/07-platform-launch/tickets/PLT-01-privacy-tos-account-delete.md:65` — Privacy/ToS legal-adequacy review.
  - `docs/prd/07-platform-launch/tickets/PLT-02-backup-pipeline.md:55` — real R2 bucket + 5 GitHub Actions secrets + one confirmed real backup run.
  No ticket in this list is missing its `[human]` item, and no other ticket outside this list carries one the issue omitted that would belong in this same funnel (the only other `[human]` items found repo-wide are milestone-level README dogfood/sign-off lines that restate these same per-ticket items at a coarser grain, e.g. `07-platform-launch/README.md:63`, `06-prep/README.md:72` — not separate facts).
- **The DATABASE_URL direct/unpooled-endpoint caveat is real**, not an invented detail: `docs/ops/backup.md` (existing runbook, read in full) states it explicitly in Troubleshooting (lines 115-126): "`pg_dump` should target the **direct/unpooled** endpoint — PgBouncer transaction-pooling mode does not support all session-level behaviour `pg_dump` relies on... set the GitHub Actions `DATABASE_URL` secret for this workflow to the **unpooled** connection string." `docs/ops/backup.md`'s own header (lines 3-5) also confirms it is PLT-02/PRD §8.2's own runbook — the issue's citation is accurate.
- **`scripts/generate-invite-codes.mjs` exists** (`Glob` confirms the path) and `docs/prd/07-platform-launch/tickets/PLT-04-invite-codes.md:54` documents its exact invocation shape (`node scripts/generate-invite-codes.mjs --count 20`), consistent with the issue's `--count 5` example.
- **PRP-03's lock condition is real and exact**: `docs/prd/06-prep/tickets/PRP-03-prep-tab-shell.md:23` quotes PRD §5.4 verbatim — "解锁条件：`job.status = interviewing`" — and its Deliverables (line 49) confirm the code check is `job.status !== 'interviewing'`. The issue's `job.status === 'interviewing'` phrasing is the correct positive form of the same gate.
- **PLT-01's account-delete behavior is real**: `docs/prd/07-platform-launch/tickets/PLT-01-privacy-tos-account-delete.md:33` describes `app/api/account/delete/route.ts` as "cascading hard-delete across all seven per-user tables plus the `users` row itself, then signs the user out" — matches the issue's Phase 6 item verbatim in substance.
- **Nothing is in flight; no file-scope contention.** `git branch --merged main` lists all 30 `ticket/*` branches for the 28 delivered tickets (plus ISS-29/30/31) as merged. Two additional local branches exist (`ticket/PLT-03-superseded`, `ticket/PLT-04-migration-collision`) but are **not** in `--merged main` and are dead/abandoned predecessor attempts superseded by the already-merged `ticket/PLT-03`/`ticket/PLT-04` — not active work. `git status --porcelain` is clean. `docs/ops/` currently contains only `backup.md`; `docs/ops/gate2-smoke-test.md` does not exist yet (confirmed by direct file check) — this ticket creates it fresh, no merge/overwrite risk.
- `pnpm` is **not** on `PATH` on the machine this pipeline runs on — always invoke it via `corepack pnpm ...`, never bare `pnpm`.

## Goal

Add `docs/ops/gate2-smoke-test.md` as a new file: a single, funnel-ordered, checkbox-driven Gate 2 smoke-test runbook containing exactly the seven sections quoted above (Phase 0 through Phase 6, plus Wrap-up), in that order, as valid GitHub-flavored Markdown, so that Horace has one document to follow end-to-end for the human Gate 2 smoke test and to record findings in.

## Non-goals

- No changes to product code, tests, or any other doc — including `docs/ops/backup.md`, which stays untouched even though this new runbook's Phase 0/Phase 6 reference the same DATABASE_URL/backup facts it documents. Cross-reference by relative link/mention only; do not duplicate-and-diverge its Troubleshooting content, and do not edit it to "sync" wording — that is a different ticket's job if ever needed.
- No new tooling, scripts, or CI steps. This is a static runbook, not automation.
- No re-deriving or second-guessing the content spec quoted in Background — the issue's phase content is the orchestrator's already-verified authoritative text (independently re-verified above); write it essentially verbatim, only reformatting as needed to produce valid GFM with real `- [ ]` checkboxes (the issue body itself already uses that syntax for every actionable line — preserve it, don't invent new steps or drop any).
- No edits to any ticket file (including this one, beyond what `/build-ticket`'s own writeback convention requires) and no edits to any PRD/README file this ticket cites.

## File-scope (write-owns)

- `docs/ops/gate2-smoke-test.md` (new file — the only file this ticket creates or modifies).
- Does not touch: any file under `app/**`, `lib/**`, `tests/**`, `scripts/**`, `.github/**`, any other file under `docs/**` (explicitly including `docs/ops/backup.md`, `docs/PRD.md`, and every `docs/prd/**` README/ticket file cited in Background — read-only references), and `.env.example`.
- Serial-safety: all 28 PRD tickets plus ISS-29/30/31 are merged into `main` (confirmed via `git branch --merged main` above); nothing is in flight. `docs/ops/gate2-smoke-test.md` does not exist yet, so there is no prior owner and no collision risk with any other ticket.

## Deliverables

1. Create `docs/ops/gate2-smoke-test.md` containing, in order: a title/intro (state its purpose — the Gate 2 human smoke test consolidating all `[human]` acceptance items across the 28-ticket PRD, cross-referencing `docs/ops/backup.md` by name for backup-specific detail rather than duplicating it), then **Phase 0 — Credential provisioning (one-time)**, **Phase 1 — Auth + app shell (FND-08/09)**, **Phase 2 — Library (LIB, P1)**, **Phase 3 — Fit report (FIT, P2)**, **Phase 4 — Tailor (TLR, P3)**, **Phase 5 — Prep (PRP, P4)**, **Phase 6 — Platform + compliance (PLT, P5)**, and a **Wrap-up** section — using the exact bullet/checkbox content quoted verbatim in Background (every `- [ ]` step, every `[human]` citation, every ticket-id parenthetical, the DATABASE_URL direct-endpoint caveat, the SECURITY note, and the Wrap-up's four bullets).
2. Every actionable step (anything the reader performs or checks) is rendered as a literal GFM task-list item: `- [ ] <text>`. Non-actionable context lines (the "Where each comes from" sub-bullets, the SECURITY note, the "Note: 1.1 + a sign-in = P0 formally exited" line, Wrap-up's bullets) may stay as plain bullets exactly as they appear in the quoted spec — do not force checkboxes onto lines the issue itself did not give a checkbox to, and do not strip a checkbox from any line the issue gave one to.
3. Section headers use the exact phase names/order from Background (`### Phase 0 — Credential provisioning (one-time)` through `### Phase 6 — Platform + compliance (PLT, P5)`, then a `### Wrap-up` or `## Wrap-up` heading — Builder's choice of heading level, as long as order and content are preserved).

## Acceptance checklist (classified)

- [ ] `[machine]` `docs/ops/gate2-smoke-test.md` exists at that exact path and is valid GFM (renders without markdown syntax errors — e.g. lints clean or is visually inspectable as well-formed task lists/headings).
- [ ] `[machine]` Every actionable step from the Background quote appears as a literal `- [ ]` checkbox line (not `- [x]`, not a plain bullet) — spot-check each phase's numbered items against the quote above.
- [ ] `[machine]` Every env var name in Phase 0 matches `.env.example` byte-for-byte: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `GLOBAL_DAILY_SPEND_LIMIT_USD`, `ADMIN_EMAILS` — no invented, renamed, or missing var; the four `R2_*` names appear only in Phase 6's backup item, never in Phase 0.
- [ ] `[machine]` The DATABASE_URL direct/unpooled-endpoint caveat is present (Phase 0's Neon bullet and/or Phase 6's backup bullet), referencing the same fact `docs/ops/backup.md` documents (per Background's verification), without contradicting it.
- [ ] `[machine]` Each phase's steps cite their ticket id(s) in parentheses exactly as quoted (e.g. `(FND-09 [human], "空应用在线")`, `(LIB-01)`, `(TLR-02 [human])`), and every one of these nine `[human]` items appears **exactly once** across the whole document: FND-05, FND-08, FND-09, LIB-03, FIT-03, TLR-02, PRP-04, PLT-01, PLT-02 (PLT-01 appears twice in Phase 6 — the Privacy/ToS review bullet and the account-delete bullet — but only the Privacy/ToS bullet is tagged `[human]` per the Background quote; account-delete's bullet has no `[human]` tag in the quoted spec, so PLT-01's `[human]` tag itself still appears exactly once — verify this distinction, do not add a second `[human]` tag to the account-delete bullet where the source spec has none).
- [ ] `[machine]` `corepack pnpm test` is green, with the exact same file/test count as the pre-ticket baseline (doc-only change touches zero test or source files — confirm via `git diff --stat` against the merge-base showing only `docs/prd/99-nightly/tickets/ISS-32-gate2-smoke-test-runbook.md`'s own status-field update, `docs/plans/ISS-32.md`, and `docs/ops/gate2-smoke-test.md`).
- [ ] `[machine]` `git diff --stat` against the merge-base shows no file outside this ticket's declared File-scope changed (no edits to `docs/ops/backup.md` or any `docs/prd/**` file this ticket cites).
- No `[human]` criteria for this ticket itself — writing a doc whose content is already fully specified and independently re-verified against the ticket set (Background) is mechanically checkable; the doc's own Phase content will later be *used* by Horace's human Gate 2 pass, but producing it is not itself a judgment call.

## Test plan

1. Reconfirm the pre-change baseline: run `corepack pnpm test` and record the file/test counts (expected around 104 files / 1239 tests per the issue's own stated baseline — exact numbers may have shifted slightly since if any other ticket landed first; zero failures is the bar regardless).
2. Create `docs/ops/gate2-smoke-test.md` per Deliverables 1-3.
3. Re-run `corepack pnpm test` and confirm the file/test counts are **identical** to step 1's baseline (a doc-only change must not add, remove, or affect any test) and exit 0.
4. `git diff --stat` against the merge-base and confirm the changed-file list matches exactly: this ticket file (status field), `docs/plans/ISS-32.md`, and `docs/ops/gate2-smoke-test.md` — nothing else.
5. Manual content cross-check (the Reviewer's job, not a new automated test — see Feedback obligation and the orchestrator brief's explicit instruction that no new automated test is added for a static doc): re-run the same greps performed in this ticket's Background verification (`grep -rn "\[human\]" docs/prd`, reading `.env.example`, reading `docs/ops/backup.md`'s Troubleshooting section) and confirm the new doc's content matches those sources — every env var name, every `[human]` citation exactly once, the DATABASE_URL caveat present and non-contradictory, every phase's ticket-id citations correct.
6. Visual/structural GFM check: confirm heading levels are consistent and every intended checkbox renders as `- [ ]` (a markdown preview or a simple regex count of `- [ ]` occurrences against the number of actionable lines in the Background quote is sufficient — no new test file is warranted for a static doc).

## Feedback obligation

1. General rule: if while transcribing the Background content the Builder finds any citation in the issue's spec that does NOT actually match the current state of a ticket file or `.env.example` (i.e. a citation this ticket's own verification above did not catch, or that changed between triage and build), stop and update this ticket (version +0.1, changelog line) with the actual finding before writing the doc with the corrected fact — do not silently write down text known to be wrong just because the issue said so.
2. This ticket must not duplicate `docs/ops/backup.md`'s content beyond what's needed for cross-reference (Non-goals) — if during writing it becomes tempting to inline backup's full Troubleshooting section into the new runbook "for completeness," stop: link/reference it by name instead (e.g. "see `docs/ops/backup.md` for the full backup runbook") and keep this ticket's own File-scope clean.
3. This ticket produces a document that Horace will use to perform the actual Gate 2 smoke test (per the project's `CLAUDE.md`: "Gate 2, a smoke test of the delivered milestone... A human is pulled in only on the exception path"). Producing the runbook does not itself constitute performing the smoke test — do not mark any of the runbook's own `- [ ]` items as checked in the delivered file; they are for Horace to tick during the real pass, not for this ticket to pre-fill.
4. If the Reviewer's content cross-check (Test plan step 5) finds a discrepancy this ticket's own Background verification missed, that is a Reviewer bounce, not a silent fix — the Builder addresses it and records the correction in this ticket's Changelog on the next pass, per the repo's standard bounce protocol (max 2 cycles, then escalate).
