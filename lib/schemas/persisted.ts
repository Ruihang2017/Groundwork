import { z } from 'zod';

import { Alignment, Edit, FitReport, Intel, JdExtract, Ledger, Rehearse } from './pipeline';

// Persisted entity schemas (PRD §5.6 data-model sketch: Job / TailoredResume /
// Brief / UsageEvent, plus the §5.6-named / §6-reported `eval_runs` table). These
// are the *persistence contract* every downstream API route validates its rows
// against, and the shapes Drizzle (FND-05) mirrors as Postgres tables. This file
// composes FND-03's pipeline stage-output schemas (JdExtract / Ledger / FitReport
// / Alignment / Edit / Intel / Rehearse) into the top-level funnel entities — it
// is the first source file in lib/schemas/** to import another source file. It
// does NOT import from lib/schemas/entities.ts: Job/TailoredResume/Brief reference
// library data only via `userId` (§5.6 sketch), never by embedding Library/Project.

// --- Job (funnel main entity) -----------------------------------------------

// PRD §5.6: Job.status: z.enum(['screening','applied','interviewing','closed']).
export const JobStatus = z.enum(['screening', 'applied', 'interviewing', 'closed']);
export type JobStatus = z.infer<typeof JobStatus>;

// Literal transcription of PRD §5.6's Job sketch — field list, types, and order
// match §5.6 exactly. `jd` (JdExtract), `ledger` (Ledger), and `fit` (FitReport)
// are REQUIRED (no .optional()/.nullable()/.default() on any of the three) — this
// is this ticket's single load-bearing constraint: a Job row is only ever created
// once READ has produced a JdExtract, and `ledger`/`fit` are set together in one
// request because CROSS (LLM) and SCORE (pure code) execute atomically in a single
// API call (04-fit/README.md decision, carried from breakdown-plan.md §6 open
// question #8). Do NOT relax these to "make Job creation easier" — that silently
// breaks the funnel's data-integrity guarantee (ticket Background; Feedback
// obligation #2 governs any overturn — escalate, do not fix locally).
//
// `createdAt`/`updatedAt` (epoch-ms, z.number() — matching entities.ts's
// Resume.updatedAt precedent, no z.date()) are an FND-04 extension beyond §5.6's
// literal code block, added because §5.6 prose requires "写操作留 `updatedAt`"
// for asset-tracked rows.
export const Job = z.object({
  id: z.string(),
  userId: z.string(),
  company: z.string(),
  role: z.string(),
  status: JobStatus,
  jdRaw: z.string(),
  jd: JdExtract,
  ledger: Ledger,
  fit: FitReport,
  createdAt: z.number(), // FND-04 extension (§5.6 prose "写操作留 updatedAt")
  updatedAt: z.number(), // FND-04 extension (§5.6 prose "写操作留 updatedAt")
});
export type Job = z.infer<typeof Job>;

// --- TailoredResume ---------------------------------------------------------

// Literal transcription of PRD §5.6's TailoredResume sketch. `alignment` reuses
// FND-03's bare-array Alignment schema as-is (do NOT re-wrap in an object).
// `createdAt`/`updatedAt` are the same FND-04 extension as Job (§5.6 prose).
export const TailoredResume = z.object({
  jobId: z.string(),
  alignment: Alignment,
  edits: z.array(Edit),
  fullDraftMd: z.string(),
  createdAt: z.number(), // FND-04 extension (§5.6 prose "写操作留 updatedAt")
  updatedAt: z.number(), // FND-04 extension (§5.6 prose "写操作留 updatedAt")
});
export type TailoredResume = z.infer<typeof TailoredResume>;

// --- Brief ------------------------------------------------------------------

// Literal transcription of PRD §5.6's Brief sketch. The `intel`/`rehearse`
// nullable-vs-required asymmetry is load-bearing product policy, not a stylistic
// choice: `intel: Intel.nullable()` encodes P3 "Degrade, don't block" (PRD §2) —
// RESEARCH may fail and a Brief still persists with `intel: null`; `rehearse:
// Rehearse` is REQUIRED (no .nullable()/.optional()) because REHEARSE failure is
// NOT degraded (PRD §5.1 REHEARSE failure policy: "JSON 修复重试 1 次 → 报错",
// same as READ/CROSS — it errors out rather than persisting a partial Brief). Do
// NOT make `rehearse` nullable "for symmetry" with `intel`; that misrepresents
// REHEARSE's actual failure policy to every Brief consumer.
// `createdAt`/`updatedAt` are the same FND-04 extension as Job (§5.6 prose).
export const Brief = z.object({
  jobId: z.string(),
  intel: Intel.nullable(),
  rehearse: Rehearse,
  createdAt: z.number(), // FND-04 extension (§5.6 prose "写操作留 updatedAt")
  updatedAt: z.number(), // FND-04 extension (§5.6 prose "写操作留 updatedAt")
});
export type Brief = z.infer<typeof Brief>;

// --- UsageEvent (append-only cost/latency ledger) ---------------------------

// PRD §5.1's six model-calling pipeline stages. 'score' is deliberately EXCLUDED:
// SCORE is pure code with no model call, so it never produces its own UsageEvent —
// it is folded into the single `cross` op's usage event (FND-10's "usage recorded
// once per user-facing operation" design, carried from 04-fit's decision). Do NOT
// add 'score' here even though it is a real pipeline stage name elsewhere; that
// would open a double-recording path for a single CROSS+SCORE API call
// (acceptance-checklist item 4 pins this).
export const UsageOp = z.enum(['parse', 'read', 'cross', 'tailor', 'research', 'rehearse']);
export type UsageOp = z.infer<typeof UsageOp>;

// Literal transcription of PRD §5.6's UsageEvent sketch. `createdAt: z.number()`
// (epoch-ms) is an FND-04 extension beyond §5.6's literal code block, needed by
// FND-06's daily-window quota/breaker queries to window against. Usage events are
// append-only/immutable — they are never updated in place, so there is
// deliberately NO `updatedAt` here (unlike Job/TailoredResume/Brief).
export const UsageEvent = z.object({
  userId: z.string(),
  op: UsageOp,
  tokensIn: z.number(),
  tokensOut: z.number(),
  searches: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  createdAt: z.number(), // FND-04 extension (FND-06 daily-window quota queries)
  // --- FND-10 extension ---------------------------------------------------
  // Added by FND-10 to satisfy PRD §8.4's "dropped / stage 状态" logging
  // requirement, absent from §5.6's literal code sketch (§5.6's UsageEvent
  // code block above lists only tokensIn/tokensOut/searches/costUsd/
  // durationMs). This is a genuine gap between §5.6's code sketch and §8.4's
  // prose, resolved here per the FND-10 ticket's own Deliverable 1 decision
  // rather than silently favoring one PRD section over the other. Both
  // default so every pre-FND-10 UsageEvent fixture (e.g.
  // lib/schemas/persisted.test.ts's validUsageEvent) keeps parsing
  // unmodified — see db/schema.ts's usageEventStatusEnum comment for the
  // mirrored Drizzle-side note.
  droppedCount: z.number().default(0),
  status: z.enum(['success', 'failure']).default('success'),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

// --- EvalRun (quality-gate report row) --------------------------------------

// PRD §6's Q1/Q2/Q3 quality-gate suites.
export const EvalSuite = z.enum(['q1', 'q2', 'q3']);
export type EvalSuite = z.infer<typeof EvalSuite>;

// FND-04 DESIGN INFERENCE — flagged as such in the ticket (Deliverable 8) and in
// 01-foundation/README.md's decisions table. PRD names the `eval_runs` table
// (§5.6) and states "每次 prompt / 模型改动必跑，报告落 `eval_runs`" (§6) but gives
// NO field-level schema. This minimal shape (which suite, which op, a pass rate,
// free-form details) is this ticket's best guess. `passRate` is a 0–1 FRACTION
// (not a 0–100 percentage) per Deliverable 8's literal .min(0).max(1). `details`
// uses Zod v4's two-argument z.record(keyType, valueType) form. If 02-evaluation/
// EVL-02 finds this insufficient when building the real harness, it edits this
// schema directly and writes back to this ticket + README (Feedback obligation #1)
// — do not silently diverge in that module.
export const EvalRun = z.object({
  id: z.string(),
  suite: EvalSuite,
  op: UsageOp,
  passRate: z.number().min(0).max(1), // 0–1 fraction, not a 0–100 percentage
  details: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});
export type EvalRun = z.infer<typeof EvalRun>;
