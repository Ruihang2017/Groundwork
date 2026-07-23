import { PROJECT_ID_PATTERN, type Project } from '@/lib/schemas/entities';

// LIB-03 — pure, DOM-free helpers behind the confirm/edit UI (plan §2.3).
//
// These live in their own module, and are unit-tested as functions rather than
// through the DOM, because the two nastiest edge cases in this ticket are string
// edge cases, not rendering ones:
//
//   E1  An empty "one metric per line" textarea must yield `[]`, NOT `['']`.
//       `['']` has length 1, so `metrics.length === 0` becomes false and BOTH
//       empty-metrics UI elements (PRD §5.7's 页顶红字盘点 + 卡片级警告) silently
//       vanish — the entire acceptance surface of this ticket disappears while
//       every render still "works". `splitList` dropping empties is the fix.
//   E8  A CJK-only / punctuation-only project name must still produce an id that
//       satisfies FND-02's `PROJECT_ID_PATTERN`, or `Library.safeParse` rejects
//       the whole confirm submission with an opaque message.
//
// PRD §5.6: "空数组是合法且被显式展示的状态" — empty arrays are a legal, displayed
// state here, never coerced to a placeholder.

export type ListSep = 'comma' | 'line';

/**
 * Split a user-typed list field into a string array.
 *
 * Trims every entry and DROPS empty ones, so `splitList('', …)` is `[]` and
 * `splitList('a,,b', 'comma')` is `['a','b']`. Handles CRLF as well as LF (a
 * resume pasted from Windows Word arrives with `\r\n`).
 */
export function splitList(input: string, sep: ListSep): string[] {
  const parts = sep === 'comma' ? input.split(',') : input.split(/\r?\n/);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** The inverse of `splitList`, used to seed a text field from stored values. */
export function joinList(values: readonly string[], sep: ListSep): string {
  return sep === 'comma' ? values.join(', ') : values.join('\n');
}

// Long enough for any real project name, short enough to stay readable in the UI
// and in a future URL segment. Not a schema constraint — FND-02 caps nothing —
// purely this module's own hygiene.
const MAX_ID_CHARS = 60;

// Used when a name yields no `[a-z0-9]` at all (CJK-only, punctuation-only, or
// empty). `Project.id` is required and pattern-checked, so there must always be
// SOMETHING valid to fall back to.
const ID_FALLBACK = 'project';

/**
 * Derive a kebab-case `Project.id` that is guaranteed to match FND-02's
 * `PROJECT_ID_PATTERN` and is not already in `taken`.
 *
 * Called ONLY when a project is created (plan §2.3). An id is never regenerated
 * when the user edits a name: ids are the join key FND-07's referential-integrity
 * layer uses downstream, so rewriting one under the user would silently re-point
 * future bindings.
 */
export function makeProjectId(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    // Every run of non-[a-z0-9] collapses to a single '-', which also rules out
    // the doubled hyphens PROJECT_ID_PATTERN rejects.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base.length > MAX_ID_CHARS) {
    // Cutting mid-string can leave a trailing '-', which the pattern rejects.
    base = base.slice(0, MAX_ID_CHARS).replace(/-+$/g, '');
  }
  if (base.length === 0) base = ID_FALLBACK;

  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A new, empty project for the "Add a project" affordance (PRD §3 C1: "手工填写
 * 只是补充与深化" — manual entry supplements importing).
 *
 * `stage`/`role` default to the literal `'unknown'`, which is LIB-01's own
 * convention for a value the resume does not state (docs/plans/LIB-01.md §2.3
 * item 8) — deliberately NOT overridden with a different sentinel here, which
 * closes LIB-01 §5 Q4 with "keep `unknown`".
 *
 * `metrics: []` means a freshly added project immediately trips both empty-metrics
 * UI elements. That is correct, not a glitch: the user has not typed a real number
 * yet, and PRD §2 P2 wants that visible.
 */
export function blankProject(taken: ReadonlySet<string>): Project {
  return {
    id: makeProjectId('', taken),
    name: '',
    stage: 'unknown',
    role: 'unknown',
    stack: [],
    summary: '',
    metrics: [],
    tags: [],
  };
}

/** How many projects have no metrics at all — the tally in PRD §5.7's banner. */
export function countMissingMetrics(projects: readonly Project[]): number {
  return projects.filter((project) => project.metrics.length === 0).length;
}

/** Re-exported so callers assert against ONE definition of the id shape. */
export { PROJECT_ID_PATTERN };

// Monotonic fallback counter for `newUid()` (see below).
let uidCounter = 0;

/**
 * A per-row React key / DOM-id prefix that is independent of `Project.id`.
 *
 * Load-bearing, not cosmetic (plan §4 E2/E3/E12):
 *   - PARSE can emit DUPLICATE `Project.id`s — LIB-01 asks the model for
 *     uniqueness and enforces it nowhere (docs/plans/LIB-01.md §4 R7). Keying on
 *     `project.id` would collide and cross-wire two cards' inputs.
 *   - Array-index keys break "remove the middle card": React reuses the DOM node
 *     and the remaining rows inherit the removed row's input state.
 *
 * `crypto.randomUUID` exists in the browser and in jsdom; the counter fallback
 * keeps this total in any environment that lacks it, since a thrown error here
 * would take down the whole page.
 */
export function newUid(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  uidCounter += 1;
  return `row-${uidCounter}`;
}
