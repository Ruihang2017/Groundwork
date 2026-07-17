---
id: PLT-01
title: Privacy policy, ToS pages, and account hard-delete
module: 07-platform-launch
lane: 07-platform-launch
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-05, FND-08]
blocks: []
---

# PLT-01 — Privacy policy, ToS pages, and account hard-delete

No ADR — the decision is already made in PRD §5.6/§8.3 ("删号 = 硬删该用户全部数据") and §3 C5 ("隐私政策与删号"); this is build ticket 1 of 4 against the `07-platform-launch` module.
Parent sub-PRD: [07-platform-launch README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-05 — Drizzle schema, Neon Postgres client, and migrations](../../01-foundation/tickets/FND-05-drizzle-schema-neon.md), [FND-08 — Auth.js v5 and session/userId scoping helper](../../01-foundation/tickets/FND-08-authjs-session.md)
**Why `builder`:** static legal pages plus a cascading-delete route against an already-decided 8-table schema — no open design; the deletion logic itself is mechanical (delete everywhere `userId` appears) but security-sensitive (see Risks in the plan the Reviewer stage will check).

## Background + basis

PRD §5.6: "**删号 = 硬删该用户全部数据**." PRD §8.3 repeats this identically in the security section. PRD §3 C5 lists "隐私政策与删号" as part of the v1 launch baseline. PRD §8.3 additionally: "简历原件不落盘；删号 = 硬删全部数据；上线前挂 Privacy Policy / ToS 页。"

PRD §5.6 also: "库为资产：写操作留 `updatedAt`，删除为软删防手滑" — this describes the LIBRARY's own accidental-edit protection (a `deletedAt` column on `libraries` only, per `01-foundation`/FND-05's Background), which is a DIFFERENT mechanism from account deletion here — this ticket's hard delete does not use or rely on that soft-delete column at all; it physically removes rows.

PRD §12 risk table: "简历 PII 泄露 | 托管平台 + 原件不落盘 + userId 隔离 + 删号硬删 + 不接第三方分析" — hard delete is explicitly named as one of the concrete mitigations for the PII-leak risk, making this ticket's correctness a direct risk-mitigation control, not just a nice-to-have feature.

The eight tables (PRD §5.6 prose, `01-foundation`/FND-05's schema) this deletion must reach: `users` (the row itself), `libraries`, `resumes` (both direct `userId` columns), `jobs` (direct `userId`), `tailored_resumes`/`briefs` (no direct `userId`, reachable only via `jobs.id` — must delete these BEFORE or via cascade with `jobs`, not leave them orphaned), `usage_events` (direct `userId` — PRD §8.4's observability data is also personal usage history, in scope for deletion), `eval_runs` (NO `userId` column at all per FND-04's schema — `eval_runs` is fixture/prompt-regression data, not per-user data, so it is correctly OUT of scope for this deletion; document this explicitly so nobody mistakes its omission for a bug).

## Goal

`app/(legal)/privacy/page.tsx`, `app/(legal)/tos/page.tsx` (static content pages, publicly reachable, not behind `middleware.ts`'s auth gate), `app/api/account/delete/route.ts` (`POST`, authenticated, cascading hard-delete across all seven per-user tables plus the `users` row itself, then signs the user out), and `app/(app)/settings/page.tsx` (a minimal settings page hosting the delete-account action with an explicit confirmation step).

## Non-goals

- No data export ("download my data") feature — PRD does not name this as a v1 requirement anywhere in §3/§5.7/§8.3; do not add it as a side effect of building delete.
- No `eval_runs` deletion — not per-user data (Background); do not touch this table.
- No soft-delete/undo window for account deletion — PRD's "硬删" (hard delete) is unconditional and immediate; a grace-period/undo feature is not named anywhere and would contradict "硬删" if it left recoverable data around.
- No changes to `libraries.deletedAt`'s existing soft-delete semantics (FND-05) — that mechanism is unrelated to this ticket (Background).

## File-scope (write-owns)

- `app/(legal)/privacy/page.tsx`, `app/(legal)/tos/page.tsx`
- `app/api/account/delete/route.ts`, `app/api/account/delete/route.test.ts`
- `app/(app)/settings/page.tsx`, `app/(app)/settings/_components/delete-account-confirm.tsx`
- `middleware.ts` — append `app/(legal)/**` to the explicitly-public (non-gated) path list (append-only per `docs/prd/breakdown-plan.md` §3; FND-08 created the file).
- Does not touch: `db/schema.ts` (FND-05, read/import table definitions only, no schema edits — deletion uses existing tables/columns), any `app/(app)/library/**`/`jobs/**` path (functional modules, read-only awareness of their table names for the delete cascade, no file edits there).
- Serial-safety: `01-foundation` fully merged before this ticket starts (module execution order, `docs/prd/breakdown-plan.md` §4). This module has no dependency on `03`–`06`, so it may run in parallel with them — but this ticket's delete route deletes rows from tables (`jobs`, `tailored_resumes`, `briefs`) whose ROUTES are owned by other modules; this ticket does not edit those modules' files, only performs `DELETE` SQL against tables FND-05 already defined, which is a data-layer operation, not a file-ownership conflict.

## Deliverables

1. `app/(legal)/privacy/page.tsx`, `app/(legal)/tos/page.tsx` — static pages with real, honest content reflecting THIS product's actual practices as documented in PRD §8.3 (userId-scoped queries, no resume-file storage, Anthropic as the only third-party data processor, hard delete on request, quota/breach-limit cost controls) — not generic boilerplate; each claim in the page text must be true of what `01-foundation`–`07-platform-launch`'s tickets actually build, per PRD §8.3's own list: "v1 不接第三方分析（自建 `usage_events` 足够）；用户数据的第三方处理方仅 Anthropic API."
2. `app/api/account/delete/route.ts` `POST` handler: (a) `requireUserId()`; (b) within ONE DB transaction, delete (in FK-safe order — children before parents): `usage_events WHERE userId = ?`, `briefs WHERE jobId IN (SELECT id FROM jobs WHERE userId = ?)`, `tailored_resumes WHERE jobId IN (SELECT id FROM jobs WHERE userId = ?)`, `jobs WHERE userId = ?`, `resumes WHERE userId = ?`, `libraries WHERE userId = ?` (hard delete, ignoring the `deletedAt` soft-delete column entirely — every row, soft-deleted or not), Auth.js's `accounts`/`sessions` rows for the user (FND-08's tables), and finally `users WHERE id = ?`; (c) sign the user out (Auth.js `signOut()`) and clear the session; (d) return HTTP 200 `{ deleted: true }`. If the transaction fails partway, it rolls back entirely — a partial account deletion must never be left in place (an inconsistent partial-delete would itself be a data-integrity/privacy bug, arguably worse than not deleting at all, since the user would believe they're deleted).
3. `app/(app)/settings/page.tsx` + `delete-account-confirm.tsx` — a settings page with a clearly-dangerous "Delete my account" action requiring an explicit confirmation step (e.g. typing a confirmation phrase or a two-click confirm dialog) before calling `POST /api/account/delete`, per standard practice for an irreversible destructive action — PRD does not specify the exact confirmation UX, so this is this ticket's own reasonable judgment call, documented as such.
4. `middleware.ts` append: add `/privacy` and `/tos` to the list of paths NOT requiring authentication (legal pages must be readable by logged-out visitors, e.g. before signing up).

## Acceptance checklist (classified)

- [ ] `[machine]` After calling the delete route for a seeded user with rows in every per-user table (`libraries`, `resumes`, `jobs`, `tailored_resumes`, `briefs`, `usage_events`, Auth.js `accounts`/`sessions`, and the `users` row itself), a follow-up query against EVERY one of those tables for that `userId` returns zero rows — this is the direct, table-by-table machine proof of PRD's "硬删该用户全部数据".
- [ ] `[machine]` `eval_runs` rows are UNCHANGED by the delete call (regression test proving the correct, deliberate exclusion from Background is not accidentally over-broad OR that a future accidental join doesn't delete unrelated data).
- [ ] `[machine]` A transaction failure injected mid-delete (mock one of the delete statements to throw) leaves ALL tables in their pre-call state — no partial deletion (rollback-atomicity test, directly addressing the "worse than not deleting" risk in Deliverable 2).
- [ ] `[machine]` `GET /privacy` and `GET /tos` are reachable without an authenticated session (integration test simulating a logged-out request).
- [ ] `[machine]` `pnpm test` green.
- [ ] `[human]` Horace reviews the Privacy Policy/ToS page content for legal adequacy before public launch — PRD names no legal-review process explicitly, but publishing legal pages without human sign-off on their accuracy/completeness is a launch-blocking risk this ticket cannot self-certify.

## Test plan

Integration tests against the local/in-memory Postgres substitute established across prior foundation tickets, seeding a full cross-table row set for one user (and a second control user, to additionally prove no cross-user deletion occurs — reusing the isolation-test pattern from `03-library`/LIB-02). The rollback-atomicity test mocks one delete statement mid-sequence to throw and asserts every table's row count is unchanged afterward.

## Feedback obligation

1. General rule: if FND-05's actual migrated schema uses different foreign-key/cascade behavior than assumed here (e.g. Postgres `ON DELETE CASCADE` already configured on some tables, making some of this ticket's explicit `DELETE` statements redundant or even conflicting), reconcile with FND-05's real migration SQL first and adjust Deliverable 2's exact statement list — record the divergence in this ticket's own notes, don't leave two delete mechanisms (application-level and DB-level cascade) racing or duplicating silently.
2. This ticket's correctness is squarely in the "security-sensitive path" category this repo's `CLAUDE.md` tells the Reviewer stage to focus on ("Focus: edge cases, concurrency, security-sensitive paths") — the Architect planning this ticket's implementation (`/plan-ticket`) should flag the concurrent-request edge case explicitly (what happens if a delete request races a Fit/Tailor/Prep request for the same user — e.g. the user has a Tailor call in flight when they hit delete) as a risk for the Reviewer to check, since this ticket's Background does not resolve that race, only the transaction-atomicity of the delete itself.
3. If Horace's legal review (the `[human]` acceptance item) requires substantive content changes to the Privacy Policy/ToS text, that is a content update inside this ticket, logged in `07-platform-launch/README.md`'s changelog — not a re-scope, unless the changes reveal an actual behavior gap (e.g. "we said we don't retain X but we actually do"), in which case that gap is a P0-severity finding requiring a code fix, escalated immediately, not just a copy edit.
