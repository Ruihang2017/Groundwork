---
id: LIB-02
title: Library and resume persistence API and query helpers
module: 03-library
lane: 03-library
size: S
agent: builder
status: draft
date: 2026-07-17
blocked_by: [LIB-01, FND-05, FND-08]
blocks: [LIB-03, FIT-01, TLR-01]
---

# LIB-02 — Library and resume persistence API and query helpers

No ADR — the decision is already made in PRD §5.1 ("草稿必须经用户确认才成为库") and §5.6 (`Library`/`Resume` tables); this is build ticket 2 of 3 against the `03-library` module.
Parent sub-PRD: [03-library README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [LIB-01 — PARSE API route](LIB-01-parse-route.md), [FND-05 — Drizzle schema, Neon Postgres client, and migrations](../../01-foundation/tickets/FND-05-drizzle-schema-neon.md), [FND-08 — Auth.js v5 and session/userId scoping helper](../../01-foundation/tickets/FND-08-authjs-session.md)
**Why `builder`:** a straightforward CRUD API over already-decided schemas/tables, with two query functions (`hasLibrary`, `getResume`) exposed for cross-module reuse — no open design.

Note: `05-tailor`/TLR-01 depends directly on this ticket (`blocks` above includes `TLR-01`) for its `getResume(userId)` call, in addition to `04-fit`/FIT-01's dependency on `hasLibrary(userId)`.

## Background + basis

PRD §5.1 PARSE row: "草稿必须经用户确认才成为库" — this ticket is where confirmation becomes persistence; LIB-01 never writes to `libraries` or `resumes`.

PRD §5.6 defines both `Library` and `Resume` (`{ sourceMd, updatedAt }`) as top-level persisted concepts, and lists `resumes` as one of the eight Postgres tables (§5.6 prose: "Postgres 表：`users / libraries / resumes / jobs / …`"). LIB-01's PARSE route produces BOTH `resumeMd` and `draftLibrary` together, and PRD's "草稿必须经用户确认才成为库" applies to the whole PARSE output as one confirmation unit — this ticket therefore persists both `Resume.sourceMd` and `Library` together, on the same confirmation action, not just `Library` alone. (An earlier draft of this module's tickets scoped this ticket to `Library` only, which left `resumes` permanently unpopulated and forced `05-tailor`/TLR-01 to reconstruct source-resume text from `Library` fields as a lossy workaround — corrected here before Gate 1 so TLR-01 can query real `resumeMd` directly.)

PRD §8.1: "**原始文件解析后即弃、不落盘**——只存 markdown 与结构化库" — persisting `Resume.sourceMd` here is exactly "只存 markdown", not the original file; this ticket never touches file bytes (LIB-01 already discarded them).

PRD §5.6: "库为资产：写操作留 `updatedAt`，删除为软删防手滑" — every write to `libraries` bumps `updatedAt`; `resumes` also carries `updatedAt` per its own schema (FND-02) though FND-05's soft-delete column (`deletedAt`) is `libraries`-specific only (per that ticket's own Background) — `resumes` rows are simply overwritten on re-import, no soft-delete needed since a resume has no independent lifecycle from its owning user's library.

PRD §5.7: "无库时禁止新建 job，CTA 引导导入简历" — this is why this ticket exposes a `hasLibrary(userId)` query: `04-fit`/FIT-03's Jobs list page needs it to gate the "new job" CTA, and FIT-01's job-creation route needs it to reject creation server-side.

PRD §5.5 layer 1 (referential integrity) and layer 3 (number integrity) both need real data this ticket is the source of: `getLibrary(userId)` feeds `getValidProjectIds(library)` (FND-07) for layer 1; `getResume(userId)` feeds `filterNumberIntegrity`'s `sourcePool.resumeMd` (FND-07) for layer 3, consumed directly by `05-tailor`/TLR-01.

## Goal

`app/api/library/route.ts` (`GET` returns the current user's `Library` + `Resume.sourceMd` or 404-equivalent null state if none exists; `POST` accepts `{ library: Library; resumeMd: string }` — matching FND-02's schemas — and upserts both together, bumping `updatedAt`) and `lib/db/queries/library.ts` exporting `getLibrary(userId)`, `hasLibrary(userId)`, `upsertLibrary(userId, library)`, `getResume(userId)`, `upsertResume(userId, sourceMd)` for reuse by other modules' server code.

## Non-goals

- No per-project edit/delete endpoints — v1's confirm/edit flow (LIB-03) operates on the whole `Library` object client-side and submits the complete edited object in one `POST`; PRD does not require granular per-project REST endpoints.
- No account-level hard delete — `07-platform-launch`/PLT-01 (this ticket's `libraries.deletedAt` column exists per FND-05's schema but this ticket does not expose any delete endpoint at all in v1).
- No independent resume-only update endpoint — `resumeMd` is only ever written together with a `Library` confirmation (Background), never on its own; there is no PRD-named user action that edits the resume text independent of a library confirm/re-import.
- No cross-user library/resume access of any kind — every query in this ticket's file is `WHERE userId = ?`, matching PRD §8.3.

## File-scope (write-owns)

- `app/api/library/route.ts`, `app/api/library/route.test.ts`
- `lib/db/queries/library.ts`, `lib/db/queries/library.test.ts` (covers both `libraries` and `resumes` table queries — one file, since they are always read/written together per Background, not two files)
- Does not touch: `app/api/parse/route.ts` (LIB-01), `app/(app)/library/**` (LIB-03).
- Serial-safety: LIB-01 merged before this ticket starts (same lane, sequential); FND-05/FND-08 merged as part of `01-foundation`'s full delivery before `03-library` began (per the module execution order in `docs/prd/breakdown-plan.md` §4) — no in-flight contention.

## Deliverables

1. `lib/db/queries/library.ts` exporting:
   - `async function getLibrary(userId: string): Promise<Library | null>` — `SELECT * FROM libraries WHERE userId = ? AND deletedAt IS NULL`, parses the stored jsonb columns back into FND-02's `Library` shape (`{ profile, projects }`).
   - `async function hasLibrary(userId: string): Promise<boolean>` — `true` iff `getLibrary` would return non-null AND `projects.length > 0` (an empty-but-existing library does not count as "has a library" for the §5.7 gating purpose).
   - `async function upsertLibrary(userId: string, library: Library): Promise<void>` — insert if no row exists for `userId`, else update `profile`/`projects` and bump `updatedAt`.
   - `async function getResume(userId: string): Promise<Resume | null>` — `SELECT * FROM resumes WHERE userId = ?`, returns `{ sourceMd, updatedAt }` (FND-02's `Resume` shape) or `null`.
   - `async function upsertResume(userId: string, sourceMd: string): Promise<void>` — insert if no row exists for `userId`, else overwrite `sourceMd` and bump `updatedAt`.
   - `async function confirmLibraryImport(userId: string, library: Library, resumeMd: string): Promise<void>` — calls `upsertLibrary` and `upsertResume` together inside one DB transaction (both succeed or both fail — a confirmation must never leave the library updated but the source resume stale, or vice versa, since `05-tailor`/TLR-01's number-integrity check depends on both being in sync).
2. `app/api/library/route.ts`:
   - `GET`: `requireUserId()` (FND-08), calls `getLibrary` and `getResume`, returns `{ library: Library | null; resumeMd: string | null }` HTTP 200 (200 even when both null — the client distinguishes "no library yet" from an error via the null fields, not via HTTP status).
   - `POST`: `requireUserId()`, parses the request body against `z.object({ library: Library, resumeMd: z.string() })` (reject with HTTP 400 on schema failure), calls `confirmLibraryImport`, returns the persisted `{ library, resumeMd }` with HTTP 200.

## Acceptance checklist (classified)

- [ ] `[machine]` `hasLibrary` returns `false` for a user with no `libraries` row.
- [ ] `[machine]` `hasLibrary` returns `false` for a user whose `libraries` row has `projects: []`.
- [ ] `[machine]` `hasLibrary` returns `true` after `confirmLibraryImport` is called with a non-empty `projects` array for that user.
- [ ] `[machine]` `getResume` returns the persisted `sourceMd` after `confirmLibraryImport`, matching what was submitted verbatim (no truncation/mutation).
- [ ] `[machine]` `confirmLibraryImport` is atomic: if `upsertResume` is mocked to throw after `upsertLibrary` succeeds, neither the `libraries` nor `resumes` row reflects the partial write (transaction rollback test).
- [ ] `[machine]` `confirmLibraryImport` called twice for the same `userId` results in exactly one `libraries` row and one `resumes` row (upsert, not insert-duplicate), both with `updatedAt` advanced on the second call.
- [ ] `[machine]` `POST /api/library` with a schema-invalid body returns HTTP 400 and does not call `confirmLibraryImport` (mocked to assert zero calls).
- [ ] `[machine]` `GET /api/library` for another user's session never returns the current user's library or resume — cross-user isolation test asserting the `WHERE userId = ?` clause is actually applied on both tables.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Integration tests in `lib/db/queries/library.test.ts` and `app/api/library/route.test.ts` against the local/in-memory Postgres substitute (or mocked Drizzle client, per whichever fallback FND-05 recorded), seeding rows directly via Drizzle before asserting query/route behavior. The transaction-atomicity test mocks `upsertResume` to throw mid-transaction and asserts both tables remain in their pre-call state. Cross-user isolation test seeds two distinct `userId`s with distinct library+resume content and asserts no leakage on either table.

## Feedback obligation

1. General rule: if `hasLibrary`'s "empty projects array doesn't count" rule turns out to be the wrong UX call once `04-fit`/FIT-03's Jobs-list gating is actually built and tested with real users, that is a product decision reversal — escalate to Horace and update this ticket + `03-library/README.md`'s decisions table before changing the function's semantics.
2. If the whole-object `POST` (no granular per-project endpoints) is found to be a poor fit once LIB-03's actual confirm/edit UI is built (e.g. concurrent edits from two tabs silently clobbering each other), document the accepted risk explicitly rather than silently adding optimistic-locking/versioning: "accepted for v1: last-write-wins on `POST /api/library`, single-user single-session usage pattern assumed, no PRD requirement for concurrent-edit protection." If found unacceptable, escalate rather than quietly adding a version column.
3. `05-tailor`/TLR-01 depends directly on `getResume` returning real, complete source-resume text (not a reconstruction) for its number-integrity check (FND-07's `filterNumberIntegrity`) — if this ticket's `Resume.sourceMd` persistence is ever found incomplete or lossy relative to what LIB-01 actually parsed, that is a P0-severity risk to TLR-01's core guardrail (PRD §2 P2, §5.3's "完整性" clause); fix here first, do not let TLR-01 compensate with a workaround.
