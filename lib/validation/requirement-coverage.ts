import type { Gap, JdExtract, Ledger } from '@/lib/schemas/pipeline';

// PRD §5.5 layer 2: "READ 提取的 requirement 未在 CROSS 输出中出现 → 自动补入
// gaps（标记 'uncovered — rerun'）。宁可暴露不完整，不静默吞掉。" This literal
// marker string is encoded into Gap.probe (Gap has no separate "reason" field
// per FND-03's schema) — FIT-02 (the only consumer) checks for this exact
// string to decide whether to surface a "rerun" affordance. Do not change this
// string without updating FIT-02's check in the same change.
export const UNCOVERED_MARKER = 'uncovered — rerun';

// Pure function: does not mutate `jd` or `ledger` — returns a new Ledger
// object with a new `gaps` array (existing gaps + injected gaps appended).
// `bindings` is defensively shallow-copied too, even though this function
// never touches it, so a caller cannot accidentally observe the *same* array
// reference being mutated by later code and mistake it for this function's
// doing (a plain aliasing-safety habit, not a functional requirement).
export function ensureRequirementCoverage(
  jd: JdExtract,
  ledger: Ledger,
): { result: Ledger; injectedGaps: Gap[] } {
  const coveredRequirementIds = new Set<string>([
    ...ledger.bindings.map((binding) => binding.requirementId),
    ...ledger.gaps.map((gap) => gap.requirementId),
  ]);

  const injectedGaps: Gap[] = [];
  for (const requirement of jd.requirements) {
    if (!coveredRequirementIds.has(requirement.id)) {
      injectedGaps.push({
        requirementId: requirement.id,
        probe: UNCOVERED_MARKER,
        // Empty string — there is nothing to bridge for a requirement the
        // model never addressed at all (as opposed to a genuine CROSS-produced
        // gap, which always has a real play). PRD does not specify a `play`
        // value for this injected case; this is this ticket's documented
        // choice (ticket Deliverable 2).
        play: '',
      });
    }
  }

  return {
    result: {
      bindings: [...ledger.bindings],
      gaps: [...ledger.gaps, ...injectedGaps],
    },
    injectedGaps,
  };
}
