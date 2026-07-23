import type {
  Binding,
  FitReport,
  Gap,
  JdExtract,
  Ledger,
  SubScore,
} from '@/lib/schemas/pipeline';
import { UNCOVERED_MARKER } from '@/lib/validation';

// FIT-03 — the Fit Report's PURE view-model. No React, no JSX, no `'use client'`,
// no I/O, no mutation of any argument.
//
// It exists because three of PRD §5.2's requirements are DERIVATIONS, not rendering:
// "分数可下钻到证据" (join a SubScore's requirementId strings back to the ledger's
// Binding/Gap objects), the "not assessed" detection FIT-02 explicitly delegated
// here, and plan D8's dropped-item derivation — which must be IDENTICAL on the
// server-render path and on the client auto-runner's 409 recovery path. Two copies
// of that last rule would drift, and the drift would be invisible to every
// component-level test. Keeping it pure also means it is tested in the NODE
// environment, with no DOM and no mocks.

/** PRD §5.2's four sub-score names, in English (§5.8's "UI 英文"). */
export const SUB_SCORE_LABELS: Record<keyof FitReport['subScores'], string> = {
  technical: 'Technical stack match',
  experienceDepth: 'Experience depth',
  domain: 'Domain match',
  evidenceStrength: 'Evidence strength',
};

/** Render order for the four cards — fixed here so both callers agree. */
export const SUB_SCORE_KEYS: Array<keyof FitReport['subScores']> = [
  'technical',
  'experienceDepth',
  'domain',
  'evidenceStrength',
];

/** One expandable entry under the dropped-count header (plan D8). */
export type DroppedItem = { label: string; detail: string };

/** The dropped-count header's whole input, on either path. */
export type DroppedView = {
  count: number;
  items: DroppedItem[];
  /**
   * True when layer 1's raw discarded entries are NOT available — i.e. on every page
   * load after the run that produced them. See `droppedFromLedger`.
   */
  partial: boolean;
};

/**
 * One requirement, with its evidence and gaps attached.
 *
 * `text`/`weight` are `null` when the id is ABSENT from the JD. That is a real,
 * reachable case, not defensive padding: FIT-02's route COUNTS hallucinated
 * requirement ids in `anomalies` but deliberately never filters them (PRD §5.5 fixes
 * the pipeline at four layers and inventing a fifth was out of its scope). PRD's
 * "宁可暴露不完整，不静默吞掉" then forbids dropping them here — the card renders the
 * raw id instead.
 */
export type RequirementView = {
  requirementId: string;
  text: string | null;
  weight: 1 | 2 | 3 | null;
  bindings: Binding[];
  gaps: Gap[];
};

/**
 * PRD §5.2's "分数可下钻到证据": FIT-02's D3 puts requirementId STRINGS in
 * `SubScore.bindings`/`.gaps`, emitted in `jd.requirements` order. This joins them
 * back to the full objects in `job.ledger`.
 *
 * Order is PRESERVED exactly as given — no sorting, no dedupe. The input order is
 * already the JD's own priority order, and re-sorting here would silently disagree
 * with the order the scorer used.
 *
 * ALL matching bindings are collected, not the first: a requirement may carry several
 * (the scorer takes the strongest for the number, but the user should see every piece
 * of evidence that was found).
 */
export function resolveRequirements(
  ids: readonly string[],
  jd: JdExtract,
  ledger: Ledger,
): RequirementView[] {
  const byId = new Map(jd.requirements.map((r) => [r.id, r]));
  return ids.map((requirementId) => {
    const requirement = byId.get(requirementId);
    return {
      requirementId,
      text: requirement?.text ?? null,
      weight: requirement?.weight ?? null,
      bindings: ledger.bindings.filter((b) => b.requirementId === requirementId),
      gaps: ledger.gaps.filter((g) => g.requirementId === requirementId),
    };
  });
}

/**
 * FIT-02's D6, whose comment names this consumer verbatim: "`SubScore.score` is a
 * non-nullable 0–100, so 'not assessed' cannot be encoded in the schema — FIT-03
 * detects it as `bindings.length === 0 && gaps.length === 0`".
 *
 * A bucket the JD stated no requirement for is EXCLUDED from the composite by the
 * scorer, and must render as "Not assessed" rather than as the number 0 — showing 0
 * for a category nobody asked about reports a failure that did not happen (plan D7).
 *
 * KNOWN DISAGREEMENT, pinned by a test rather than left to be discovered (plan §5
 * Q2): `evidenceStrength` with zero bindings has `weightSum === 0` (so the scorer
 * excludes it from the composite) but a NON-EMPTY `gaps` array (every unbound
 * requirement is listed there informationally). This predicate therefore reports it
 * as ASSESSED and the UI shows a real 0. That 0 is honest — the JD asked and the
 * library had nothing — and D7's "average of the sub-scores that were assessed" line
 * keeps the arithmetic from looking broken. Resolving the disagreement properly means
 * the scorer exposing "assessed" explicitly; that is Horace's call, not this file's.
 */
export function isNotAssessed(sub: SubScore): boolean {
  return sub.bindings.length === 0 && sub.gaps.length === 0;
}

/** True when ANY of the four buckets was excluded from the composite (plan D7). */
export function hasUnassessedBucket(fit: FitReport): boolean {
  return SUB_SCORE_KEYS.some((key) => isNotAssessed(fit.subScores[key]));
}

/**
 * Layer-2's injected gaps — the ONLY part of PRD §5.5 layer 1's dropped set that
 * survives into the database.
 *
 * `UNCOVERED_MARKER` is IMPORTED, never retyped: it contains an EM DASH
 * ('uncovered — rerun'), and a hand-typed hyphen version compiles, reads correctly at
 * a glance, and silently never matches.
 */
export function uncoveredGaps(ledger: Ledger): Gap[] {
  return ledger.gaps.filter((gap) => gap.probe === UNCOVERED_MARKER);
}

/**
 * The RELOAD path's dropped view (plan D8), and the auto-runner's 409-recovery path.
 *
 * `partial: true` ALWAYS. FIT-02's route header states the limitation plainly:
 * `dropped.bindings` exists only in the response that produced it and `jobs` has no
 * column for it. So on any later page load the recoverable count is layer 2's
 * injections alone — a SMALLER number than the one shown moments earlier.
 *
 * Showing that smaller number with no note was rejected: a count that silently
 * shrinks between the first view and a refresh is worse than either honest option and
 * is exactly the silent inconsistency PRD's "宁可暴露不完整，不静默吞掉" forbids.
 * Showing nothing was also rejected — the count IS partially recoverable and PRD §5.7
 * requires it. The note is the whole point.
 */
export function droppedFromLedger(ledger: Ledger, jd: JdExtract): DroppedView {
  const gaps = uncoveredGaps(ledger);
  const byId = new Map(jd.requirements.map((r) => [r.id, r]));
  return {
    count: gaps.length,
    items: gaps.map((gap) => ({
      label: byId.get(gap.requirementId)?.text ?? gap.requirementId,
      detail: 'The analysis did not cover this requirement, so it was re-injected as a gap.',
    })),
    partial: true,
  };
}

/** FIT-02's `dropped` payload, exactly as its wire contract defines it. */
export type FitRunDropped = {
  count: number;
  bindings: Array<{ item: Binding; reason: string }>;
  uncoveredRequirementIds: string[];
};

/**
 * The FRESH-FIT path's dropped view: the full picture, available exactly once.
 *
 * `partial: false` — layer 1's raw discarded bindings are in hand here, which is what
 * PRD §5.5 layer 1's "前端可查看被弃原始条目" actually asks for. `count` is taken from
 * the response rather than recomputed from the arrays, so the number the user sees is
 * the same number `usage_events.droppedCount` recorded.
 */
export function droppedFromResponse(dropped: FitRunDropped, jd: JdExtract): DroppedView {
  const byId = new Map(jd.requirements.map((r) => [r.id, r]));
  const label = (requirementId: string) => byId.get(requirementId)?.text ?? requirementId;

  return {
    count: dropped.count,
    items: [
      ...dropped.bindings.map(({ item, reason }) => ({
        label: label(item.requirementId),
        detail: `Evidence from "${item.projectId}" was discarded (${reason}): ${item.evidence}`,
      })),
      ...dropped.uncoveredRequirementIds.map((requirementId) => ({
        label: label(requirementId),
        detail: 'The analysis did not cover this requirement, so it was re-injected as a gap.',
      })),
    ],
    partial: false,
  };
}
