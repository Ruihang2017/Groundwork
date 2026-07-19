import { filterNumberIntegrity } from '../../lib/validation/number-integrity.ts';
import { ensureRequirementCoverage } from '../../lib/validation/requirement-coverage.ts';
import type { ZodType } from 'zod';
import type { JdExtract, Ledger, Rehearse } from '../../lib/schemas/pipeline.ts';

// EVL-02 Deliverable 3 — the Q1 (结构门) deterministic checks. Every function is
// pure and synchronous, operating on already-produced stage output. See
// docs/plans/EVL-02.md §2.3.
//
// PLAIN-NODE NOTE (§2.1): the two runtime imports reach lib/validation/* by
// RELATIVE path with an explicit `.ts` extension — NOT the `@/*` alias and NOT
// lib/validation/index.ts (that barrel re-exports via extensionless relative
// paths Node's resolver cannot follow). Both target files are safe to load under
// plain Node: requirement-coverage.ts has only an `import type` (erased),
// number-integrity.ts has no imports. Type-only refs use `import type`.

// PRD §6 Q1: "schema 通过率（含 1 次 repair）". This checks only the FINAL parse
// result — it does NOT itself perform the repair retry (each stage route owns its
// own "JSON 修复重试 1 次 → 报错" logic, PRD §5.1). `repairAttempted` does not
// branch pass/fail; it only distinguishes the two failure modes in `detail` so a
// report reader can tell "invalid even after a repair" from "invalid, no repair".
export function assertQ1Schema(
  rawOutput: unknown,
  schema: ZodType,
  repairAttempted: boolean,
): { pass: boolean; detail: string } {
  const result = schema.safeParse(rawOutput);
  if (result.success) {
    return { pass: true, detail: 'schema valid' };
  }
  const summary = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  const prefix = repairAttempted
    ? 'schema invalid even after 1 repair attempt'
    : 'schema invalid, no repair attempted';
  return { pass: false, detail: `${prefix}: ${summary}` };
}

// PRD §6 Q1: "requirement 覆盖恰好一次". Reuses FND-07's ensureRequirementCoverage
// to detect requirements covered by NEITHER bindings nor gaps, and ADDS the
// "恰好一次" double-check ensureRequirementCoverage alone does not perform: a
// requirement id appearing in BOTH bindings and gaps is also a violation.
export function assertQ1Coverage(
  jd: JdExtract,
  ledger: Ledger,
): { pass: boolean; uncoveredCount: number } {
  const { injectedGaps } = ensureRequirementCoverage(jd, ledger);
  const uncoveredCount = injectedGaps.length;

  const bindingRequirementIds = new Set(
    ledger.bindings.map((binding) => binding.requirementId),
  );
  let duplicateCount = 0;
  for (const gap of ledger.gaps) {
    if (bindingRequirementIds.has(gap.requirementId)) {
      duplicateCount += 1;
    }
  }

  return {
    pass: uncoveredCount === 0 && duplicateCount === 0,
    uncoveredCount,
  };
}

// PRD §6 Q1: "questions == 5 且 trap 非空". Re-asserted here as an explicit named
// Q1 check even though FND-03's schema already Zod-enforces both — a caller may
// pass hand-built/mock data that never went through the schema, so this function
// must not assume Zod already validated it.
export function assertQ1Questions(rehearse: Rehearse): { pass: boolean; detail: string } {
  if (rehearse.questions.length !== 5) {
    return {
      pass: false,
      detail: `expected exactly 5 questions, got ${rehearse.questions.length}`,
    };
  }
  const emptyTrapIndex = rehearse.questions.findIndex((question) => question.trap.length === 0);
  if (emptyTrapIndex !== -1) {
    return { pass: false, detail: `question at index ${emptyTrapIndex} has an empty trap` };
  }
  return { pass: true, detail: '5 questions, all traps non-empty' };
}

// PRD §6 Q1: "tailor 数字完整性违规 = 0". Reuses FND-07's filterNumberIntegrity;
// `pass` is strictly `violationCount === 0`.
export function assertQ1NumberIntegrity(
  tailorOutput: { fullDraftMd: string },
  sourcePool: { resumeMd: string; libraryMetrics: string[] },
): { pass: boolean; violationCount: number } {
  const { dropped } = filterNumberIntegrity(tailorOutput.fullDraftMd, sourcePool);
  return { pass: dropped.length === 0, violationCount: dropped.length };
}

// PRD §6 Q1: "dropped 率 … dropped < 15%". `pass` uses a STRICT `<` (0.15 exactly
// fails). `totalCount === 0` degenerates to rate 0 / pass true (no items, nothing
// dropped) rather than NaN.
export function assertQ1DroppedRate(
  droppedCount: number,
  totalCount: number,
): { pass: boolean; rate: number } {
  const rate = totalCount === 0 ? 0 : droppedCount / totalCount;
  return { pass: rate < 0.15, rate };
}
