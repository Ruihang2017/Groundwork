---
id: TLR-01
title: TAILOR API route
module: 05-tailor
lane: 05-tailor
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-03, FND-04, FND-05, FND-06, FND-07, FND-10, FIT-02, EVL-02, LIB-02]
blocks: [TLR-02]
---

# TLR-01 — TAILOR API route

No ADR — the decision is already made in PRD §5.1 (TAILOR row), §5.3 (spec), §5.5 layers 1+3; this is build ticket 1 of 2 against the `05-tailor` module.
Parent sub-PRD: [05-tailor README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-03 — Pipeline stage payload Zod schemas](../../01-foundation/tickets/FND-03-pipeline-payload-schemas.md), [FND-04 — Persisted entity Zod schemas](../../01-foundation/tickets/FND-04-persisted-entity-schemas.md), [FND-05 — Drizzle schema, Neon Postgres client, and migrations](../../01-foundation/tickets/FND-05-drizzle-schema-neon.md), [FND-06 — Model, pricing, and quota configuration](../../01-foundation/tickets/FND-06-model-pricing-quota-config.md), [FND-07 — Server-side validation layer utilities](../../01-foundation/tickets/FND-07-server-validation-layers.md), [FND-10 — Usage and cost observability recording helper](../../01-foundation/tickets/FND-10-usage-recording.md), [FIT-02 — CROSS and SCORE route](../../04-fit/tickets/FIT-02-cross-score-route.md), [EVL-02 — Q1-Q3 evaluation harness](../../02-evaluation/tickets/EVL-02-eval-harness.md), [LIB-02 — Library and resume persistence API and query helpers](../../03-library/tickets/LIB-02-persistence-api.md)
**Why `builder`:** implementing a single stage route (TAILOR) against already-decided schemas and validation layers, with a fresh (not migrated) prompt per `05-tailor/README.md`'s open question #2 resolution — no open design.

This ticket reads real `Resume.sourceMd` via LIB-02's `getResume(userId)`, not a reconstruction (LIB-02 was corrected before Gate 1 to persist the resume alongside the library specifically so TLR-01 has a real, complete number-integrity source).

## Background + basis

PRD §5.1 TAILOR row: "**TAILOR** | 用户决定投 | `resumeMd + JdExtract + Ledger` → 对齐表 + edits + 全文草稿 | 每条 edit 绑 `projectId`（P1）；数字完整性校验（P2）；缺失技能 → gap 提示、不入文；可读性优先于关键词密度 | JSON 修复重试 1 次 → 报错". The trigger is "用户决定投" (the user decides to apply) — this route is called once a Fit Report exists (`job.fit`/`job.ledger` populated by `04-fit`/FIT-02), triggered by a user action on the Fit tab or a dedicated "Tailor" button, not gated on any further status requirement PRD names (PRD's funnel narrative §4 S3 says "点击 Tailor" directly follows S2, with no explicit status-transition requirement — `job.status` stays whatever it was, typically `'screening'`, until TLR-02's own "mark as applied" action runs).

PRD §5.3, quoted verbatim (the full feature spec this route implements): "**关键词对齐表**：JD 关键词 → 简历中 present / missing / 同义失配（如 'K8s' vs 'Kubernetes'）。missing 区分两类：库里有、简历没写 → 改写解决；库里也没有 → 显示为 gap，绝不写入简历。**逐条 edits**：`{原文, 建议改写, 理由, 来源 projectId}`，用户逐条采纳，不是黑盒整篇替换。**全文草稿**：markdown 就地编辑；导出 = 打印友好页 → 浏览器打印 PDF（模板系统进 roadmap）。**完整性**：输出中任何数值必须存在于源简历或库 metrics（服务端 regex 交叉校验，违规条目剔除并计数展示）。" — "resumeMd" in the trigger row and "源简历" in the 完整性 clause both mean `Resume.sourceMd` as persisted by `03-library`/LIB-02, which this ticket reads directly.

PRD §2 P1 (upgraded for Tailor specifically): "在简历定制场景，这条原则升格为产品底线：**只重组、换措辞、调强调，永不替用户编造技能和事实**——缺什么显示为 gap，不写进简历。prompt 会漂移，校验不会。" — "prompt 会漂移，校验不会" is why this ticket's server-side validation (referential integrity on `Edit.projectId`, number-integrity on `fullDraftMd`) is non-negotiable even though the prompt also carries the instruction; the code-level check is the actual enforcement, the prompt is best-effort. The "missing_in_library → gap, never written into the resume" rule is enforced at the PROMPT level (instruct the model never to fabricate a skill the library doesn't have), since there's no library-driven source to filter it against after the fact the way number-integrity works.

## Goal

`app/api/jobs/[id]/tailor/route.ts` (`POST`, no body needed beyond the job id) that runs TAILOR (LLM → `Alignment` + `Edit[]` + `fullDraftMd`), applies FND-07's referential-integrity (on `Edit.projectId`) and number-integrity (on `fullDraftMd`, checked against the real persisted `Resume.sourceMd` plus library metrics) layers, persists the result as `TailoredResume`, and returns it.

## Non-goals

- No UI — TLR-02.
- No "mark as applied" logic — TLR-02 calls FIT-01's existing status PATCH route directly from the UI, this route does not touch `job.status`.
- No quota bucket reuse from Fit — `tailor` is its own quota bucket (PRD §8.3: "5 tailor"/day), checked once in this route (unlike Fit's two-call charged-once-upfront design — TAILOR is a single call, so there is no "which call charges it" ambiguity to resolve).
- No resume persistence logic — reads (never writes) `resumes` via LIB-02's already-corrected `getResume(userId)`.

## File-scope (write-owns)

- `app/api/jobs/[id]/tailor/route.ts`, `app/api/jobs/[id]/tailor/route.test.ts`
- `lib/db/queries/tailored-resumes.ts`, `lib/db/queries/tailored-resumes.test.ts`
- `lib/tailor/prompt.ts`
- Does not touch: `app/api/jobs/**` (FIT-01/FIT-02, read/call only via their exported query functions), `lib/db/queries/library.ts` (LIB-02, read/import `getLibrary`/`getResume` only), `app/(app)/jobs/[id]/resume/**` (TLR-02).
- Serial-safety: all of `01-foundation`, `02-evaluation`, `03-library`, and `04-fit` are fully merged before this ticket starts (per the module execution order in `docs/prd/breakdown-plan.md` §4) — no in-flight contention.

## Deliverables

1. `lib/tailor/prompt.ts` exporting the TAILOR stage prompt, written fresh (PRD 附录A confirms TAILOR has no legacy asset — "PARSE / TAILOR 为新增" — so `05-tailor/README.md` open question #2 is resolved by this fact alone, no hand-off needed), instructing the model per PRD §5.3's full spec (Background): keyword alignment with the present/missing_in_resume/missing_in_library/synonym_mismatch split (matching FND-03's `AlignmentEntry` enum exactly), per-edit `{original, suggested, rationale, projectId}`, full draft markdown, readability-over-keyword-density, and the explicit "never fabricate a skill the library doesn't have" instruction.
2. `lib/db/queries/tailored-resumes.ts` exporting `upsertTailoredResume(jobId, alignment, edits, fullDraftMd)` (one `TailoredResume` per `jobId` — re-running Tailor for the same job overwrites the prior draft, matching PRD's framing of Tailor as a per-job, re-runnable action, not a versioned history) and `getTailoredResume(userId, jobId)` (joins through `jobs` to enforce `userId` scoping, since `tailored_resumes` has no direct `userId` column per FND-05's schema).
3. `app/api/jobs/[id]/tailor/route.ts` `POST` handler: (a) `requireUserId()`; (b) `getJob(userId, jobId)` (FIT-01) — HTTP 404 if absent; HTTP 409 `{ error: 'fit_not_ready' }` if `job.fit`/`job.ledger` are absent (Tailor requires a completed Fit, per PRD's "用户决定投" trigger implying Fit already happened); (c) `getLibrary(userId)` and `getResume(userId)` (both LIB-02) — HTTP 409 `{ error: 'no_library' }` if either is absent (defensive — should be unreachable in practice since FIT-01 already gated job creation on `hasLibrary`, and `03-library`/LIB-02's Non-goals rules out any delete path in v1, but kept as defense-in-depth); (d) `checkAndIncrementQuota(userId, 'tailor')` (FND-06) — HTTP 429 if not allowed; (e) `checkGlobalBreaker()` — HTTP 503 if tripped; (f) call Anthropic with `PRIMARY_MODEL`, the TAILOR prompt, `job.jdRaw`/`job.jd`, `job.ledger`, the `Library`, and `resume.sourceMd`; parse against a Zod shape covering `Alignment` + `Edit[]` + `fullDraftMd` (FND-03), one JSON-repair retry, HTTP 422 on unrecoverable failure; (g) apply `filterByReferentialIntegrity` (FND-07) to `edits` using `getValidProjectIds(library)`; (h) apply `filterNumberIntegrity` (FND-07) to `fullDraftMd` using `{ resumeMd: resume.sourceMd, libraryMetrics: <all Project.metrics flattened from library.projects> }`; (i) `upsertTailoredResume(...)`; (j) `recordUsage()` with `op: 'tailor'`, `droppedCount` = sum of (g)+(h)'s dropped counts; (k) return the `TailoredResume` with HTTP 200.

## Acceptance checklist (classified)

- [ ] `[machine]` `POST /api/jobs/[id]/tailor` for a job with no `fit`/`ledger` returns HTTP 409 `{ error: 'fit_not_ready' }` and never calls the Anthropic client.
- [ ] `[machine]` `checkAndIncrementQuota(userId, 'tailor')` is called exactly once per request, before the Anthropic call.
- [ ] `[fixture]` For each of a set of EVL-01 JD+resume fixture pairs (reusing FIT-02's own pairing convention, with the resume fixture's text pre-seeded into `resumes` via LIB-02's `upsertResume` in the test setup), calling this route (Anthropic client mocked with a canned response containing at least one deliberately-injected fabricated number not present in the source) results in that fabricated number being ABSENT from the persisted `fullDraftMd`, and counted in `droppedCount` — via `02-evaluation`/EVL-02's `assertQ1NumberIntegrity`, this is the concrete `[fixture]` acceptance item feeding PRD §10 P3's "数字完整性违规 = 0".
- [ ] `[machine]` A mocked edit with a `projectId` not in the library is dropped from the persisted `edits` array and counted (direct test of layer 1 applied to `Edit[]`).
- [ ] `[machine]` A number present verbatim in the seeded `resume.sourceMd` (but not in any `Project.metrics`) is RETAINED in `fullDraftMd`, not incorrectly dropped — regression test proving the real `getResume` source pool (not a lossy reconstruction) is actually used.
- [ ] `[machine]` `pnpm test` green.

## Test plan

Unit/integration tests mocking the Anthropic client (including at least one test response deliberately containing a fabricated number and one deliberately containing an invalid `projectId`, to exercise both validation layers) and using the local/in-memory Postgres substitute for persistence assertions, seeding `libraries` AND `resumes` rows via LIB-02's query functions before each test (not hand-rolled SQL, so this ticket's tests exercise the real cross-module contract). `[fixture]` item follows the same mocked-model, real-assertion-logic pattern established in FIT-01/FIT-02's own tests, with a separate manually-triggered real-model smoke run documented before P3 sign-off (same convention as LIB-01/FIT-02).

## Feedback obligation

1. General rule: this ticket's number-integrity guarantee is only as strong as `03-library`/LIB-02's `Resume.sourceMd` persistence being complete and faithful to what LIB-01 actually parsed from the original file — if a gap is found (e.g. a legitimate number that only ever appeared in the original resume's formatting/tables and was lost somewhere in the PARSE→confirm→persist chain), that is a P0-severity risk to PRD §2 P2's guardrail; escalate to `03-library/README.md` and fix the persistence chain, do not loosen this ticket's `filterNumberIntegrity` call to compensate.
2. If the real Q1 number-integrity pass rate (from the manually-triggered real-model run) shows any violation slipping through (not just correctly-flagged-and-dropped ones — an actual fabricated number reaching the user), that is the PRD §7 P0 metric directly ("质量 | 证据 / 改写幻觉 P0 | = 0") — 24h fix commitment applies, fix `lib/tailor/prompt.ts` and/or FND-07's `filterNumberIntegrity` regex coverage, and add the failing case to `02-evaluation`'s fixture corpus per that module's changelog convention.

## Changelog

- v0.1 (2026-07-23, Builder writeback): implemented against `docs/plans/TLR-01.md`. Five new files — `lib/tailor/prompt.ts`, `lib/db/queries/tailored-resumes.ts` (+ test), `app/api/jobs/[id]/tailor/route.ts` (+ test). No migration (the `tailored_resumes` table already exists, migration `0000`), no new dependency, no change to any file outside this ticket's write-scope. Full suite green: 77 files / 1001 tests; `pnpm lint` clean; `pnpm build` with `DATABASE_URL` unset exits 0 (the `/api/jobs/[id]/tailor` route appears in the manifest — the lazy-import safety and async-`params` type both hold).

  ### Design resolutions implemented (plan §0.1 — each is recorded at its implementation site)

  - **D1** — TAILOR's model input is `job.jd` (the persisted `JdExtract`) + `job.ledger` (the fitted `Ledger`) + the caller's `Library` with `profile.contact` stripped + `resume.sourceMd`. **`job.jdRaw` is NEVER sent** (see Deviations #1).
  - **D2** — the `Library` sent to the model is an explicit allow-list `{ profile: { name, headline, targetRole }, projects }`; `profile.contact` (PII) is omitted entirely, built without mutating the caller's object. TAILOR defines its own `libraryForPrompt` helper rather than importing CROSS's.
  - **D3** — the route-local reply shape is `TailorOutput = z.object({ alignment: Alignment, edits: z.array(Edit), fullDraftMd: z.string() })`, module-local in the route file (breakdown-plan.md §3), reusing FND-03's `Alignment`/`Edit` value schemas as-is.
  - **D4** — only HARD (repairable) failures, no "soft" category: truncated (`stop_reason: 'max_tokens'`), non-JSON, `TailorOutput.safeParse` failure, a NUL byte anywhere in the parsed object, or a blank `fullDraftMd`. One repair turn on any HARD failure; still HARD (or repair transport-null, or skipped for lack of budget) ⇒ 422 `tailor_failed`. There is deliberately no per-field blank check on every edit/alignment string (the filter layers are the real guardrails; edits are adopted individually).
  - **D5** — **NO replay guard.** `upsertTailoredResume` overwrites the prior draft (one row per `jobId`). Safe here precisely because quota is charged on EVERY request (5/day `tailor`), so there is no "one charge → unlimited paid calls" abuse vector that forced FIT-02's `already_fitted` guard. Recorded as a code comment at the upsert site.
  - **D6** — no degenerate short-circuit: past the gates, TAILOR always makes its one paid call (its core output is meaningful even for a thin JD, and quota was already charged).
  - **D7** — the 200 body is the persisted `TailoredResume` at the top level plus one additive `dropped: { count, edits, numbers }` key, `Cache-Control: no-store`. Known limitation (Q2): `dropped` is not persisted (no column), so it lives only in this 200 body.
  - **D8** — `upsertTailoredResume(jobId, alignment, edits, fullDraftMd)` takes NO `userId` (a load-bearing precondition: the route MUST have verified ownership via `getJob(userId, id)` first); `getTailoredResume(userId, jobId)` joins through `jobs` for user-scoping (no `userId` column on `tailored_resumes`). Both use LIB-02's lazy-memoized `dbIndex()` build-safety pattern; select-then-update/insert (no UNIQUE on `jobId` ⇒ no `onConflictDoUpdate`); reads `ORDER BY updatedAt DESC LIMIT 1`.

  ### Deviations from the ticket text

  1. **TAILOR receives `job.jd` (the `JdExtract`), NOT `job.jdRaw`** — a deliberate departure from the literal Deliverable 3(f) wording "`job.jdRaw`/`job.jd`" (plan §0.1 D1, Open Question Q1). PRD §5.1's TAILOR row states the input as "`resumeMd + JdExtract + Ledger`" (JdExtract, not the raw posting), and §5.3's alignment table works off "JD 关键词" which `JdExtract.atsKeywords` + requirement texts already carry. `jdRaw` is the rawest fully-attacker-controlled text; sending it would re-expose the injection surface and double paid input tokens (same reasoning as FIT-02's D1). Ship default: `jd`-only. If Horace intended the full raw posting, that re-opens the injection-surface decision — recorded as a 决策 row + Open Question Q1 in `05-tailor/README.md`.
  2. **Layer scoping**: `filterByReferentialIntegrity` (layer 1) is applied to **`edits` only**, `filterNumberIntegrity` (layer 3) to **`fullDraftMd` only**; `alignment` passes through unchanged (it carries no `projectId`, and it is keyword analysis, not résumé content shipped to a recruiter). See Open Question Q3 on whether `edits[].suggested` should also be number-filtered and whether TLR-02 should re-run the filter at export.
  3. **The "never fabricate a skill the library lacks / `missing_in_library` → gap, never in the draft" rule is PROMPT-enforced, and its test is a PROXY.** There is no library-driven source to filter alignment against after the fact (unlike number integrity, which the server enforces against the real `Resume.sourceMd`), so this rule ships as a prompt-content assertion (route test) + the manual smoke recipe at the bottom of `lib/tailor/prompt.ts`. A green CI run must NOT be read as "the model obeys it against real inputs". Feedback obligation #2 governs a real violation.
  4. **The `[fixture]` acceptance (item 3) runs against canned replies**, per the ticket's own Test plan: each of the 10 EVL-01 JD fixtures (paired with `resumes[i % 3]`, the resume text seeded via LIB-02's `upsertResume`) is swept with a canned reply carrying a deliberately-injected fabricated number; the test asserts that number is absent from the persisted `fullDraftMd`, is counted in `dropped.count`, and that `assertQ1NumberIntegrity` reports `violationCount 0` on the FILTERED draft. This proves the filter wiring, not model quality; the real Q1 number requires the smoke run.

  ### Confirmations required by upstream tickets

  - **FND-06's `QUOTA_OP_TO_USAGE_OP` re-confirmed** (that table's comment obliges each consumer to re-verify it): `tailor` quota bucket ↔ usage op `'tailor'` is a 1:1 name match, a single paid call, no ambiguity. `checkAndIncrementQuota(userId, 'tailor')` is called exactly once, before the paid call (a test pins the count and the ordering), and `recordUsage({ op: 'tailor' })` on success counts against the same bucket. `checkGlobalBreaker()` is re-checked immediately after, failing CLOSED on any throw.
