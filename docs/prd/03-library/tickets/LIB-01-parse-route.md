---
id: LIB-01
title: PARSE API route (PDF / DOCX / pasted text)
module: 03-library
lane: 03-library
size: M
agent: builder
status: draft
date: 2026-07-17
blocked_by: [FND-02, FND-06, FND-08, FND-10, EVL-01]
blocks: [LIB-02]
---

# LIB-01 — PARSE API route (PDF / DOCX / pasted text)

No ADR — the decision is already made in PRD §5.1 (PARSE row) and §8.1 (parsing tech decisions); this is build ticket 1 of 3 against the `03-library` module.
Parent sub-PRD: [03-library README](../README.md). Master spec: [PRD](../../../PRD.md).
Depends on: [FND-02 — Core simple-entity Zod schemas](../../01-foundation/tickets/FND-02-core-entity-schemas.md), [FND-06 — Model, pricing, and quota configuration](../../01-foundation/tickets/FND-06-model-pricing-quota-config.md), [FND-08 — Auth.js v5 and session/userId scoping helper](../../01-foundation/tickets/FND-08-authjs-session.md), [FND-10 — Usage and cost observability recording helper](../../01-foundation/tickets/FND-10-usage-recording.md), [EVL-01 — Fixture corpus](../../02-evaluation/tickets/EVL-01-fixture-corpus.md)
**Why `builder`:** implementing a single stage route (PARSE) against already-decided schemas, model config, and validation posture — no product design left open.

## Background + basis

PRD §5.1 PARSE row, quoted verbatim: "**PARSE** | 导入简历 | 文件/文本 → `resumeMd` + 草稿 Library | metrics 只取简历中出现的真实数字（P2）；草稿必须经用户确认才成为库 | 解析失败 → 引导粘贴纯文本". The "草稿必须经用户确认才成为库" clause is why this route must NOT persist to `libraries` — it returns the draft to the client; persistence-on-confirm is LIB-02's job (see `03-library/README.md`'s decision table).

PRD §8.1: "**简历解析**：PDF 走 Anthropic 原生 document input（对版式鲁棒，免解析库）；DOCX 经 mammoth 提取文本；兜底粘贴纯文本。**原始文件解析后即弃、不落盘**——只存 markdown 与结构化库。这是隐私决策，顺带消灭了文件存储依赖。" — this route must never write the uploaded file to disk/blob storage in any form, and must discard it from memory once the LLM call completes (no lingering buffer beyond the request lifecycle).

PRD §2 P2: "**Retrieve, don't generate。** 数字永不虚构。库中项目没有 metrics，界面显示 'no metrics' 警告且绑定强度封顶 `partial`" and PRD §5.1's own PARSE-row clause: "metrics 只取简历中出现的真实数字（P2）" — the PARSE prompt must instruct the model to only populate `Project.metrics` with numbers literally present in the source text, never invented ones; this is a prompt-authoring responsibility of this ticket, not a server-side filter (there is no source-of-truth to cross-check PARSE's output against yet — the resume itself IS the source, so the discipline here is prompt-level, unlike TAILOR's server-side number-integrity check in FND-07 which has an independent source to check against).

PRD §5.1's failure policy for PARSE: "解析失败 → 引导粘贴纯文本" — on any parse failure (malformed PDF, unreadable DOCX, model error), the route returns a structured error response that the client UI (LIB-03) uses to prompt the user to paste plain text instead, rather than a generic 500.

PRD §5.6: `Resume = z.object({ sourceMd: z.string(), updatedAt: z.number() })` (FND-02) — `resumeMd` in the PRD §5.1 table maps to this `Resume.sourceMd` field.

## Goal

`app/api/parse/route.ts` (`POST`, multipart or JSON body carrying either a PDF file, a DOCX file, or pasted plain text) that returns `{ resumeMd: string; draftLibrary: Library }` (both FND-02 types) on success, or a structured `{ error: 'parse_failed', suggestPaste: true }` on failure — never persists anything, never writes the original file anywhere, records usage via FND-10.

## Non-goals

- No persistence to `libraries`/`resumes` tables — LIB-02.
- No confirm/edit UI — LIB-03.
- No PARSE quota check — `03-library/README.md`'s decision table explicitly says PARSE has no quota bucket (PRD §8.3 only names fit/tailor/prep); do not add a `checkAndIncrementQuota()` call for `parse` — FND-06's `DAILY_QUOTA` has no `parse` key by design (FND-06 acceptance checklist enforces this) so any attempt to check it would be a type error, which is intentional friction against inventing one.
- No global-breaker check either? — NO: this ticket DOES call FND-06's `checkGlobalBreaker()` before making the paid PARSE call, since the global daily spend circuit breaker (PRD §8.3: "全局日花费熔断阈值") applies to ALL paid operations, not just the three quota-bucketed ones — do not skip this just because PARSE has no per-user quota; these are two independent controls and only the per-user one is PARSE-exempt.

## File-scope (write-owns)

- `app/api/parse/route.ts`, `app/api/parse/route.test.ts`
- `lib/parse/pdf.ts` (Anthropic document-input request builder for PDF), `lib/parse/docx.ts` (mammoth-based text extraction), `lib/parse/prompt.ts` (the PARSE stage prompt text/template)
- Does not touch: `lib/db/queries/library.ts` (LIB-02), `app/(app)/library/**` (LIB-03), `lib/schemas/**` (FND-02/03, read/import only).
- Serial-safety: `01-foundation` (all 10 tickets) and `02-evaluation`/EVL-01 are fully merged before this ticket starts (per `docs/prd/breakdown-plan.md` §4's module execution order) — no in-flight contention on any imported file.

## Deliverables

1. `lib/parse/pdf.ts` exporting `buildPdfParseRequest(fileBuffer: Buffer): AnthropicMessageRequest` — constructs the Messages API request using Anthropic's native PDF document-input content block (per PRD §8.1), with `model: PRIMARY_MODEL` (FND-06) and a system/user prompt (from `lib/parse/prompt.ts`) instructing the model to produce `{ resumeMd, draftLibrary }` matching FND-02's `Resume`/`Library` shape, with explicit instructions: "only include numbers/metrics that literally appear in the source text; if a project has no stated metrics, return an empty `metrics` array — never estimate or infer a number."
2. `lib/parse/docx.ts` exporting `extractDocxText(fileBuffer: Buffer): Promise<string>` using `mammoth` (new dependency — append to `package.json` per the foundation-owned-file append convention) to extract plain text, then reuses the same prompt template as the PDF path but as a text-input call rather than a document-input block (mammoth-extracted text is passed as a plain string, not re-sent as a document).
3. `lib/parse/prompt.ts` exporting the PARSE stage prompt (system + instructions), written fresh against PRD §5.1's rules (per `02-evaluation/README.md`'s open question #2 — no legacy prompt asset is available; author this from PRD §5.1/§5.6 directly, do not assume a hand-off exists).
4. `app/api/parse/route.ts` — `POST` handler: (a) `requireUserId()` (FND-08); (b) `checkGlobalBreaker()` (FND-06) — if tripped, return HTTP 503 `{ error: 'global_breaker_tripped' }` before making any paid call; (c) branch on request content-type/body shape: PDF file → `buildPdfParseRequest` + call Anthropic; DOCX file → `extractDocxText` then call Anthropic with the extracted text; pasted plain text → call Anthropic directly with the text; (d) parse the model's JSON response against `z.object({ resumeMd: z.string(), draftLibrary: Library })` (FND-02's `Library`), with one JSON-repair retry on parse failure (re-prompt once asking the model to fix its JSON, per PRD §5.1's general "JSON 修复重试 1 次" pattern applied here even though PARSE's own row states a different failure UX — the repair retry is about malformed JSON specifically, "解析失败 → 引导粘贴纯文本" is about the parse ultimately not producing usable output even after repair); (e) on unrecoverable failure (bad file, repair also fails), return `{ error: 'parse_failed', suggestPaste: true }` with HTTP 422; (f) on success, call `recordUsage()` (FND-10) with `op: 'parse'`, then return `{ resumeMd, draftLibrary }` with HTTP 200; (g) never write the uploaded file/buffer to any persistent store — it exists only in the request handler's memory for the duration of the call.

## Acceptance checklist (classified)

- [ ] `[fixture]` For each of the 3 resume fixtures in `fixtures/resumes/*.md` (EVL-01), calling this route (with the fixture text as the pasted-plain-text path, since the fixtures are `.md` files, not real PDFs) produces a `draftLibrary` that parses successfully against FND-02's `Library` schema, with at least one non-empty `projects` array — this is the concrete machine-checkable form of PRD §10 P1's "3 份 fixture 简历解析正确" (mocking the actual Anthropic API call with a canned valid response for this ticket's own CI run, since a real API call is non-deterministic and costs money on every CI run — see Test plan).
- [ ] `[machine]` A malformed/empty PDF buffer input results in HTTP 422 `{ error: 'parse_failed', suggestPaste: true }`, not an unhandled exception.
- [ ] `[machine]` When `checkGlobalBreaker()` is mocked to return `tripped: true`, the route returns HTTP 503 before any Anthropic call is attempted (assert the mocked Anthropic client was never invoked).
- [ ] `[machine]` A successful parse calls `recordUsage()` exactly once with `op: 'parse'`.
- [ ] `[machine]` The route never calls any file-write/blob-storage API (static check: no `fs.writeFile`/upload-SDK import in `app/api/parse/route.ts` or `lib/parse/**` — grep-based test, enforcing the §8.1 privacy decision mechanically).
- [ ] `[machine]` `pnpm test` green.

## Test plan

1. Mock the Anthropic client (dependency-injected or module-mocked, per the pattern established in `02-evaluation`/EVL-02's `judge.ts` tests) to return a canned valid `{ resumeMd, draftLibrary }` JSON matching one of EVL-01's resume fixtures' expected content shape — assert the route's response parses against FND-02's `Library` schema. Run this once per fixture (3 total), satisfying the `[fixture]` acceptance item without making real, non-deterministic, costed API calls in CI.
2. Unit test the malformed-input path with a garbage buffer, asserting HTTP 422 and the `suggestPaste: true` field.
3. Unit test the global-breaker-tripped path with `checkGlobalBreaker` mocked, asserting HTTP 503 and zero calls to the mocked Anthropic client.
4. Static/grep test asserting no filesystem-write or blob-upload API is referenced in this ticket's files.
5. A separate, NOT-part-of-`pnpm test`, manually-triggered smoke script (documented in this ticket's own code comments, e.g. `lib/parse/manual-smoke.md` or a comment block) for Horace/a human to run once against the real Anthropic API with a real fixture PDF before P1 sign-off — this is the closest this ticket gets to proving the PDF-document-input path (not just the text path) actually works, since CI cannot spend real API budget on every run; flagged explicitly rather than silently only testing the text path.

## Feedback obligation

1. General rule: the PARSE prompt (`lib/parse/prompt.ts`) is new, hand-authored content (no legacy asset per `02-evaluation/README.md`'s open question #2) — if it fails to produce usable output against real fixtures during the manual smoke check (Test plan item 5), fix the prompt here and record the fixture that caught the failure as feedback into `02-evaluation`'s corpus (extend `fixtures/manifest.json`/add a regression note in `02-evaluation/README.md`'s changelog) so the failure mode isn't silently re-introduced later.
2. If mammoth's DOCX extraction loses structural information (e.g. section headers, bullet lists) badly enough that the model can't reliably distinguish projects from other resume sections, that is a real quality risk for the metrics-fabrication guardrail (Background) — do not silently accept degraded DOCX parsing; escalate to Horace whether DOCX support should be de-scoped to "convert to PDF first" guidance in the UI (a `03-library`/LIB-03 UI decision) rather than papering over it here.
3. If PRD 附录A's actual PARSE-adjacent assets are handed off later (the seed library, per `02-evaluation/README.md` open question #1), this ticket's prompt/fixtures do not need retroactive changes unless the hand-off reveals a concrete gap in current behavior — note receipt in `03-library/README.md`'s changelog either way.
