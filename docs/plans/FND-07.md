# Implementation plan — FND-07: Server-side validation layer utilities

Ticket: [docs/prd/01-foundation/tickets/FND-07-server-validation-layers.md](../prd/01-foundation/tickets/FND-07-server-validation-layers.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §5.5 (server-side validation / trust boundary — the entire load-bearing spec for this ticket, quoted in full below), §5.3 ("输出中任何数值必须存在于源简历或库 metrics（服务端 regex 交叉校验，违规条目剔除并计数展示）"), §5.7 (dropped-count UI requirement — consumed by a later ticket, not built here), §6 (Q1 gate: "requirement 覆盖检查恰好一次"、"tailor 数字完整性违规 = 0"、"dropped 率 < 15%"), §7 ("证据 / 改写幻觉 P0 = 0")
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) line 51 (`lib/validation/**` → `01-foundation`/FND-07: "referential integrity / requirement coverage / number integrity / blacklist，PRD §5.5 四层")
Depends on (merged): [docs/plans/FND-02.md](FND-02.md) (`lib/schemas/entities.ts` — `Library`/`Project`), [docs/plans/FND-03.md](FND-03.md) (`lib/schemas/pipeline.ts` — `JdExtract`/`Ledger`/`Binding`/`Gap`/`Edit`/`RehearseQuestion`)
Downstream (read this plan's decisions before starting): FIT-02 (layers 1+2 on `Ledger.bindings`/`Job.jd`), TLR-01 (layers 1+3 on `TailoredResume.edits`/`fullDraftMd`), PRP-02 (layer 1 on `Rehearse.questions`), EVL-02 (reuses `dropped`/`injectedGaps` output shapes for Q1 assertions — does not own assertion logic itself)

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline -1`: HEAD is `7853c98` (merge ticket/FND-06 into main: model/pricing/quota config). `git status`: working tree clean, up to date with `origin/main`. **`7853c98` is the base commit** the Builder's diff should be measured against. `git branch -a` shows `main`, `ticket/FND-01` … `ticket/FND-06`, `remotes/origin/main` — **no `ticket/FND-07` branch exists yet**.
- `lib/validation/` **does not exist yet** — this ticket creates it from scratch (5 source files + 4 test files, per the ticket's own File-scope; no `index.test.ts` — the ticket's File-scope lists `lib/validation/*.test.ts` "one per layer", i.e. four test files, and Deliverable 5's `index.ts` is a pure re-export barrel with no logic of its own to test).
- `lib/schemas/entities.ts` (FND-02, merged) exports, confirmed by direct read: `Profile`, `Project` (with `id: z.string().regex(PROJECT_ID_PATTERN, ...)`, kebab-case), `PROJECT_ID_PATTERN`, `Library` (`{ profile: Profile, projects: Project[] }`), `Resume`, plus every inferred TS type. `Library.projects[].id` is the field Deliverable 1's `getValidProjectIds` reads.
- `lib/schemas/pipeline.ts` (FND-03, merged) exports, confirmed by direct read, the exact fields this ticket depends on:
  - `JdExtract.requirements[]` = `{ id: string; text: string; weight: 1|2|3; category: RequirementCategory }` — `id` is the join key Deliverable 2 needs.
  - `Binding` = `{ requirementId: string; projectId: string; strength: 'strong'|'partial'; evidence: string }` — has `projectId`.
  - `Gap` = `{ requirementId: string; probe: string; play: string }` — **no separate "reason" field**, confirming the ticket's own Background note that the `uncovered — rerun` marker must go in `probe`.
  - `Ledger` = `{ bindings: Binding[]; gaps: Gap[] }` — a disjoint union encoded as two arrays (FND-03's explicit, load-bearing shape decision — Deliverable 2 must read/write this shape as-is, not restructure it).
  - `Edit` = `{ original: string; suggested: string; rationale: string; projectId: string }` — has `projectId`.
  - `RehearseQuestion` = `{ projectId: string; question: string; trap: string }` — has `projectId`.
  - All three of `Binding`, `Edit`, `RehearseQuestion` structurally satisfy a `{ projectId: string }` constraint — confirms Deliverable 1's generic `filterByReferentialIntegrity<T extends { projectId: string }>` type-checks against all three without modification.
- `vitest.config.ts`'s `test.include` is `['tests/**/*.test.ts', 'lib/**/*.test.ts', 'db/**/*.test.ts']` (widened by FND-02's writeback, reused by every subsequent `lib/**` ticket per `01-foundation/README.md`'s v0.3 changelog, most recently confirmed unused-by-need in FND-06's plan). `lib/validation/*.test.ts` is already discovered — **no `vitest.config.ts` change needed**.
- `tsconfig.json`'s `include` (`**/*.ts`) and `eslint.config.mjs`'s global `next/core-web-vitals` + `next/typescript` config both already cover `lib/**` with no per-ticket changes needed (same finding as every prior `01-foundation` plan).
- `package.json` has no dependency this ticket needs to add — these are plain TypeScript/pure-function files with **no runtime import of `zod`** (they consume already-validated, already-typed objects; they do not construct or run Zod schemas themselves) and no other new package. **No `package.json`/`pnpm-lock.yaml` change.**
- Serial-safety: per `docs/prd/breakdown-plan.md` line 51, `lib/validation/**` is FND-07's exclusive file-scope within the `01-foundation` lane — no other ticket in this lane (FND-08/09/10, not yet started) writes to this path. FND-02 and FND-03 (this ticket's `blocked_by`) are both merged; FND-07 has exclusive, uncontended access to every file in its File-scope.

## 1. Scope

**In scope** (per ticket Deliverables 1–5, File-scope):

- New file `lib/validation/referential-integrity.ts` — `filterByReferentialIntegrity<T extends { projectId: string }>` + `getValidProjectIds(library: Library)`.
- New file `lib/validation/requirement-coverage.ts` — `ensureRequirementCoverage(jd, ledger)`.
- New file `lib/validation/number-integrity.ts` — `filterNumberIntegrity(text, sourcePool)` + `extractNumericTokens(text)`.
- New file `lib/validation/blacklist.ts` — `BLACKLIST_PATTERNS` + `flagBlacklistedPhrases(text)`.
- New file `lib/validation/index.ts` — barrel re-export of all of the above.
- Four colocated test files: `lib/validation/referential-integrity.test.ts`, `lib/validation/requirement-coverage.test.ts`, `lib/validation/number-integrity.test.ts`, `lib/validation/blacklist.test.ts`.

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):

- No DB queries anywhere in `lib/validation/**` — every function is a pure function over already-fetched, in-memory data (`Library`, `Resume.sourceMd`, `Project.metrics`, a `JdExtract`, a `Ledger`, generated text) passed in by the caller. No `import ... from '@/db/...'` anywhere in this ticket's files.
- No wiring into any `app/api/**` route — FIT-02 (layers 1+2), TLR-01 (layers 1+3), PRP-02 (layer 1) call these functions from their own route handlers later. This ticket does not touch `app/**`.
- No UI (dropped-count banners, expandable dropped-item lists) — that is FIT-03/TLR-02/PRP-04's job (PRD §5.7).
- No eval-harness Q1/Q2 assertion/threshold logic — `02-evaluation`/EVL-02 owns that; this ticket's functions only produce the raw `dropped`/`injectedGaps`/`flagged` data EVL-02 will later assert against.
- No edit to `lib/schemas/**` — read/import only (types, not values requiring a Zod runtime import).
- No `.env.example`, `vitest.config.ts`, `tsconfig.json`, `eslint.config.mjs`, or `package.json` change — §0 confirms none of the ticket's acceptance criteria require touching any of them.

## 2. Change list

### 2.1 `lib/validation/referential-integrity.ts` (new file) — Layer 1

```ts
import type { Library } from '@/lib/schemas/entities';

// PRD §5.5 layer 1: "projectId ∈ library，否则从 bindings / edits / questions 中
// 移除，dropped 计数随响应返回，前端可查看被弃原始条目（透明性）". Generic over
// any array of objects carrying a `projectId` field — Binding (FND-03),
// Edit (FND-03), RehearseQuestion (FND-03) all structurally satisfy this
// constraint (confirmed in §0); do NOT write three copies of this filter.
//
// Pure function: no mutation of `items` (returns new arrays), no DB access.
export function filterByReferentialIntegrity<T extends { projectId: string }>(
  items: T[],
  validProjectIds: Set<string>,
): { result: T[]; dropped: Array<{ item: T; reason: 'projectId not in library' }> } {
  const result: T[] = [];
  const dropped: Array<{ item: T; reason: 'projectId not in library' }> = [];

  for (const item of items) {
    if (validProjectIds.has(item.projectId)) {
      result.push(item);
    } else {
      dropped.push({ item, reason: 'projectId not in library' });
    }
  }

  return { result, dropped };
}

// Convenience for callers — builds the Set filterByReferentialIntegrity needs
// from a Library's Project.id list (FND-02: kebab-case, PROJECT_ID_PATTERN-
// constrained at the schema layer already; no re-validation of the pattern
// here, only membership).
export function getValidProjectIds(library: Library): Set<string> {
  return new Set(library.projects.map((project) => project.id));
}
```

Notes for the Builder:

- `validProjectIds.has(...)` is an **exact, case-sensitive** string match — do not add case-normalization "for robustness." `Project.id` is already schema-constrained to lowercase kebab-case (FND-02's `PROJECT_ID_PATTERN`); a case-mismatched `projectId` in generated output is exactly the kind of hallucinated/mismatched reference this layer exists to catch and drop transparently, not silently coerce into a match.
- Do not use `Array.prototype.filter` alone (which would give you `result` but not `dropped` in one pass) — the single `for` loop above builds both in one traversal, matching the ticket's requirement that the function return *both* the filtered result and the structured dropped list (Background, final paragraph: "must return both the filtered result AND a structured record of what was dropped/flagged").

### 2.2 `lib/validation/requirement-coverage.ts` (new file) — Layer 2

```ts
import type { Gap, JdExtract, Ledger } from '@/lib/schemas/pipeline';

// PRD §5.5 layer 2: "READ 提取的 requirement 未在 CROSS 输出中出现 → 自动补入
// gaps（标记 'uncovered — rerun'）。宁可暴露不完整，不静默吞掉。" This literal
// marker string is encoded into Gap.probe (Gap has no separate "reason" field
// per FND-03's schema — confirmed in §0) — FIT-02 (the only consumer) checks
// for this exact string to decide whether to surface a "rerun" affordance. Do
// not change this string without updating FIT-02's check in the same change.
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
```

Notes for the Builder:

- This function only ever **adds** gaps for zero-coverage requirements; it does not deduplicate or flag requirements that appear in *both* `bindings` and `gaps` (over-coverage) — that is Q1's "requirement 覆盖检查恰好一次" assertion, owned by `02-evaluation`/EVL-02, explicitly out of this ticket's scope (Non-goals: "No eval-harness Q1/Q2 assertion logic").
- `UNCOVERED_MARKER` is exported (not requested by the ticket's Deliverable list, but low-risk and directly useful to FIT-02, which the ticket's own Background section says "needs to check for this literal marker string" — exporting the constant instead of making FIT-02 re-type the literal string is a defensive-against-typos choice; if the Reviewer considers this an unrequested-export deviation, it is trivially reversible).

### 2.3 `lib/validation/number-integrity.ts` (new file) — Layer 3

This is the ticket's highest-design-risk file — see §4 for the false-positive/false-negative tradeoffs made explicit here.

```ts
// PRD §5.3: "输出中任何数值必须存在于源简历或库 metrics（服务端 regex 交叉校验，
// 违规条目剔除并计数展示）". PRD §5.5 layer 3: "产出中的数值不存在于源简历/库 →
// 剔除并计数（P2 的机器实现）". This is P2's actual enforcement mechanism
// ("Retrieve, don't generate。数字永不虚构") — see the ticket's Feedback
// obligation #3: a false negative found later during TLR-01's Q1/Q2 fixture
// testing is P0-severity (PRD §7: "证据 / 改写幻觉 P0 = 0"). The regex below is
// a starting point, not a closed/complete implementation — its known blind
// spots are documented below and in this plan's §4, not hidden.
//
// Matches integers, decimals, comma-grouped thousands, percentages,
// currency-prefixed amounts ($/€/£), and short-scale/multiplier suffixes
// (K/M/B/x) as used in resume metrics: "40%", "$1.2M", "3x", "12,000",
// "300ms" (extracts "300", the unit letters "ms" are not consumed — see the
// suffix group's trailing negative lookahead, which backs off rather than
// swallowing a partial unit word).
//
// (?<![A-Za-z0-9]) leading lookbehind: excludes digits embedded in an
// identifier (e.g. the "8" in "K8s") from being treated as a numeric claim.
// (?:[KkMmBb](?![A-Za-z])|[Xx](?![A-Za-z]))? suffix group: only consumes a
// K/M/B/x suffix letter when it is NOT immediately followed by another
// letter — this is what lets "300ms"/"45min" correctly yield "300"/"45"
// instead of failing to match at all (an earlier draft of this regex, using a
// plain trailing negative lookahead over the WHOLE match, incorrectly failed
// to match "300ms" at all — see this file's test suite for the regression
// case that pins this).
const NUMERIC_TOKEN_REGEX =
  /(?<![A-Za-z0-9])[$€£]?\d[\d,]*(?:\.\d+)?(?:[KkMmBb](?![A-Za-z])|[Xx](?![A-Za-z]))?%?/g;

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/,/g, '');
}

// Reusable primitive (Deliverable 3) — used both internally by
// filterNumberIntegrity and, per the ticket, potentially by 02-evaluation's
// Q1 dropped-rate assertions. Uses String.prototype.matchAll, NOT a manual
// `while ((m = REGEX.exec(text)))` loop — matchAll does not mutate the
// passed-in regex's `lastIndex` (per the ECMAScript spec, it operates on an
// internal clone), so this function is safe to call repeatedly / reentrantly
// against the same module-level NUMERIC_TOKEN_REGEX without any risk of a
// stale `lastIndex` silently truncating a later call's matches. See §4 for
// why this matters (this is the file's one shared-mutable-state hazard).
export function extractNumericTokens(text: string): string[] {
  return [...text.matchAll(NUMERIC_TOKEN_REGEX)].map((match) => match[0]);
}

export function filterNumberIntegrity(
  text: string,
  sourcePool: { resumeMd: string; libraryMetrics: string[] },
): {
  result: string;
  dropped: Array<{ token: string; reason: 'number not found in source resume or library metrics' }>;
} {
  const sourceText = [sourcePool.resumeMd, ...sourcePool.libraryMetrics].join('\n');
  const sourceTokens = new Set(extractNumericTokens(sourceText).map(normalizeToken));

  const dropped: Array<{
    token: string;
    reason: 'number not found in source resume or library metrics';
  }> = [];

  let result = '';
  let cursor = 0;

  // Index-based reconstruction (NOT text.replace(token, '')) — a naive
  // replace-by-string-value approach only removes the FIRST occurrence of a
  // repeated token string, silently leaving a second occurrence of the same
  // unsupported number untouched. Iterating matches by position and splicing
  // each dropped span out individually handles repeated identical tokens
  // correctly regardless of how many times they appear.
  for (const match of text.matchAll(NUMERIC_TOKEN_REGEX)) {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;

    result += text.slice(cursor, start);

    if (sourceTokens.has(normalizeToken(token))) {
      result += token; // retained — present in source pool
    } else {
      dropped.push({ token, reason: 'number not found in source resume or library metrics' });
      // omitted from result entirely — not replaced with a placeholder
    }

    cursor = end;
  }
  result += text.slice(cursor);

  return { result, dropped };
}
```

Notes for the Builder:

- `NUMERIC_TOKEN_REGEX` is **not exported** — Deliverable 3 names exactly `filterNumberIntegrity` and `extractNumericTokens` as the public surface; keep the regex itself an internal implementation detail (same discipline FND-06's plan used for its own internal-only `QUOTA_OP_TO_USAGE_OP` map).
- `sourceTokens` membership comparison is via `normalizeToken` (lowercase + comma-stripped) so `"1.2M"` in generated text matches `"1.2m"` in source prose, and `"12,000"` matches `"12000"`. This is **not** unit-aware numeric equivalence — `"$1.2M"` and `"$1,200,000"` are treated as two different, non-matching tokens. This is a documented, known limitation (see §4), not an oversight.
- `dropped[].token` reports the **raw matched substring exactly as it appeared in `text`** (pre-normalization) — this mirrors PRD's transparency principle for layer 1 ("前端可查看被弃原始条目") applied consistently to layer 3's dropped list, so a future UI (out of scope here) can show the user exactly what was removed.
- No whitespace-collapsing pass is applied to `result` after removal (e.g. `"grew revenue by 45% last year"` with `"45%"` dropped becomes `"grew revenue by  last year"` — a cosmetic double space). The ticket does not specify a formatting rule here; left as a Builder judgment call (§5, Open question 1) as long as no test depends on exact spacing beyond "the dropped token string is absent from `result`."

### 2.4 `lib/validation/blacklist.ts` (new file) — Layer 4

```ts
// PRD §5.5 layer 4: "废话黑名单（regex）：'be honest' / 'stay calm' 类命中即标记
// low-quality，记录不阻断——作为 prompt 回归信号。" Ticket Deliverable 4 names
// the starter list VERBATIM (four phrases, not just PRD's two examples) — this
// is a direct transcription of the ticket's own text, not this plan's
// invention. Adjusting this list later is a product/config decision per the
// ticket's Feedback obligation #2 (escalate to Horace; note in
// 01-foundation/README.md if it needs to change materially) — not a silent
// code edit.
//
// Every pattern carries the 'g' flag (required for String.prototype.matchAll
// — it throws a TypeError on a non-global regex) and 'i' (case-insensitive,
// per acceptance-checklist item 4: "matches 'be honest' case-insensitively").
// The apostrophe in "it's important to note" is matched as either a straight
// (') or curly (') apostrophe — a small, low-risk robustness addition beyond
// the ticket's literal string, since LLM-generated text commonly uses curly
// quotes; flagged as a minor plan-level extension in §5, not ticket-mandated.
export const BLACKLIST_PATTERNS: RegExp[] = [
  /\bbe honest\b/gi,
  /\bstay calm\b/gi,
  /\bat the end of the day\b/gi,
  /\bit['’]s important to note\b/gi,
];

// Non-mutating, per PRD: "记录不阻断" (record, don't block). Returns matches
// only — never removes or alters `text`. Uses matchAll per pattern (not a
// stateful exec()/test() loop) for the same lastIndex-safety reason as
// number-integrity.ts's extractNumericTokens — see §4.
export function flagBlacklistedPhrases(
  text: string,
): { flagged: Array<{ pattern: string; match: string }> } {
  const flagged: Array<{ pattern: string; match: string }> = [];

  for (const pattern of BLACKLIST_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      flagged.push({ pattern: pattern.source, match: match[0] });
    }
  }

  return { flagged };
}
```

Notes for the Builder:

- Do not add a "remove flagged phrases from text" code path, even as a convenience — PRD is explicit this layer is non-blocking ("记录不阻断"); it exists as a prompt-regression signal only (see the ticket's Non-goals and this plan's §4 for why a future well-intentioned refactor into an active filter would be a product-policy regression, not a bug fix).
- `pattern.source` (the regex's string form, without flags) is used as the `pattern` field's value in `flagged[]` — a stable, human-readable identifier for which starter-list entry matched, without re-exposing the `RegExp` object itself in the return value.

### 2.5 `lib/validation/index.ts` (new file) — barrel

```ts
export { filterByReferentialIntegrity, getValidProjectIds } from './referential-integrity';
export { ensureRequirementCoverage, UNCOVERED_MARKER } from './requirement-coverage';
export { extractNumericTokens, filterNumberIntegrity } from './number-integrity';
export { BLACKLIST_PATTERNS, flagBlacklistedPhrases } from './blacklist';
```

Matches Deliverable 5's stated import surface: `import { filterByReferentialIntegrity, ensureRequirementCoverage, filterNumberIntegrity, flagBlacklistedPhrases } from '@/lib/validation'` (plus the two convenience/constant exports named above, which are additive and do not change that stated surface).

### 2.6 Test files (one per layer, `lib/validation/*.test.ts`)

Pattern-matched to `lib/schemas/entities.test.ts`/`lib/schemas/pipeline.test.ts`'s established style: plain `describe`/`it`/`expect` blocks, hand-built inline fixtures, no `fixtures/**` reference (does not exist yet — ticket's own Test plan explicitly forbids referencing it, matching FND-02/FND-03's precedent), `Schema.parse`/`.safeParse(...).success` not applicable here (these are not Zod schemas) — instead direct value assertions (`.toEqual`, `.toBe`, `.toContain`).

**`lib/validation/referential-integrity.test.ts`**

- `filterByReferentialIntegrity`: mixed-validity array of 3 `Binding`-shaped fixtures (2 valid `projectId`s in the set, 1 not) → `result` has 2, `dropped` has 1 with `reason: 'projectId not in library'` and the exact dropped item preserved (acceptance item 1).
- Same test repeated with `Edit`-shaped and `RehearseQuestion`-shaped fixtures — proves the generic actually works across all three real FND-03 types, not just one (this is the ticket's own stated reason the function must be generic; assert it, don't just declare it).
- Empty `items` array → `result: []`, `dropped: []` (trivial boundary case).
- `getValidProjectIds`: a `Library` fixture with 2 projects → returns a `Set` containing exactly those 2 `id`s; a `Library` with 0 projects → empty `Set`.
- Case-sensitivity: a `projectId` differing only in case from a valid library id (e.g. library has `voice-agent`, item has `Voice-Agent`) is dropped, not matched — pins the §4/§2.1 "no case-normalization" decision so a future edit cannot silently soften it.

**`lib/validation/requirement-coverage.test.ts`**

- Positive case: a `JdExtract` with one requirement whose `id` is absent from both `ledger.bindings[].requirementId` and `ledger.gaps[].requirementId` → `injectedGaps` has exactly one `Gap` with `probe: 'uncovered — rerun'` and `play: ''`; `result.gaps` contains the original gaps plus this injected one (acceptance item 2, positive half).
- Negative case: every requirement already covered (one via a `Binding`, one via an existing `Gap`) → `injectedGaps` is `[]`, `result` is unchanged in content (deep-equal to input plus copied-not-same-reference arrays) (acceptance item 2, negative half).
- Purity: call the function, then assert the original `ledger` object passed in is unchanged (`toEqual` against a snapshot taken before the call) — proves no mutation, and that `result !== ledger` (different object identity) plus `result.gaps !== ledger.gaps` (different array identity).
- Multiple uncovered requirements in one call → multiple injected gaps, one per uncovered requirement id, in the same order as `jd.requirements`.

**`lib/validation/number-integrity.test.ts`**

- Removal case: `filterNumberIntegrity('grew revenue 45%', { resumeMd: 'led backend team', libraryMetrics: [] })` → `result` does not contain `'45%'`, `dropped` has exactly one entry `{ token: '45%', reason: 'number not found in source resume or library metrics' }` (acceptance item 3, removal half — this is the ticket's own literal example).
- Retention case (via `resumeMd`): same call but `resumeMd: 'Revenue grew 45% year over year'` → `result` still contains `'45%'`, `dropped` is `[]` (acceptance item 3, retention half).
- Retention case (via `libraryMetrics`): `resumeMd: ''`, `libraryMetrics: ['grew ARR 45%']` → same retention assertion — proves both halves of `sourcePool` are actually checked, not just `resumeMd` (ticket's Deliverable 3 explicitly names both).
- `extractNumericTokens` direct unit tests (the exported primitive, tested independently of `filterNumberIntegrity`):
  - Plain integer (`'12'`), decimal (`'3.5'`), comma-grouped (`'12,000'`), percentage (`'40%'`), currency+decimal+suffix (`'$1.2M'`), multiplier (`'3x'`), unit-suffixed number correctly truncates to the numeric part (`'300ms'` → `['300']`, `'45min'` → `['45']`) — regression-pins the suffix group's trailing negative lookahead described in §2.3.
  - `'K8s'` → `[]` (no false-positive digit extraction from an identifier — pins the leading lookbehind).
  - Multiple tokens in one string, in order: `'reduced latency from 500ms to 300ms, a 40% improvement'` → `['500', '300', '40%']`.
- Round-trip consistency: the same literal substring (e.g. `'$1.2M'`) extracted from both a generated-text string and a source-pool string produces tokens that normalize equal via the same `normalizeToken` logic the production code uses (indirectly tested by the retention-case tests above, but add one explicit case pairing differently-cased inputs, e.g. text has `'$1.2M'`, source has `'$1.2m'`, still retained — proves the case-insensitive normalization path).
- No test asserts exact whitespace shape of `result` after a removal beyond "the dropped token substring is not present" (per §2.3's note that whitespace-collapsing is not mandated).

**`lib/validation/blacklist.test.ts`**

- `flagBlacklistedPhrases('To be honest, I think this is fine.')` → `flagged` is non-empty, contains an entry with `match` matching case-preserved `'be honest'`; input string reference/value unchanged after the call (acceptance item 4 — compare `text` variable before/after, plus a direct equality assertion on the input string itself, satisfying the ticket's literal "input/output equality" phrasing).
- Case-insensitivity: `'BE HONEST'` and `'Be Honest'` both flagged.
- Each of the other three starter phrases (`'stay calm'`, `'at the end of the day'`, `"it's important to note"`) individually flagged in a minimal sentence.
- Curly-apostrophe variant (`'it’s important to note'`) also flagged — pins the §2.4 apostrophe-robustness addition (flagged to the Reviewer as a plan-level extension in §5, not ticket-mandated — if the Reviewer prefers strict literal transcription only, this is a one-line, low-risk reversion).
- Clean text with no blacklisted phrases → `flagged: []`.
- Multiple distinct blacklisted phrases in one string → multiple entries in `flagged`, one per match (not deduplicated).

No test in any of the four files references `fixtures/**` (does not exist yet — `02-evaluation` builds it after this ticket, per the ticket's own Test plan).

## 3. Test plan

Maps directly to the ticket's acceptance checklist; each item is what the Builder/Reviewer actually runs.

1. **`pnpm test` exits 0**, and its output lists all four new suites (`lib/validation/referential-integrity.test.ts`, `requirement-coverage.test.ts`, `number-integrity.test.ts`, `blacklist.test.ts`) alongside every pre-existing suite (`tests/**`, `lib/schemas/**` from FND-02/03/04, `lib/config/**` from FND-06, `db/**` from FND-05) — confirms `vitest.config.ts`'s already-widened `include` picks up the four new files with zero config change (§0/§2.6). Don't just check the exit code — check the file list, per this repo's established "don't let a glob miss create a false green" discipline (FND-02/FND-05/FND-06 plans' precedent).
2. **Targeted assertions**, all covered by §2.6's test files — re-verify each is actually present and actually exercised:
   - `filterByReferentialIntegrity` drops an item with an invalid `projectId`, keeps valid items, reports the dropped item with the exact reason string (acceptance item 1).
   - `ensureRequirementCoverage` injects exactly one `Gap` with `probe: 'uncovered — rerun'` for an uncovered requirement, and injects nothing when all requirements are covered (acceptance item 2).
   - `filterNumberIntegrity` removes `'45%'` from `'grew revenue 45%'` when absent from both source-pool fields, retains it when present in either (acceptance item 3).
   - `flagBlacklistedPhrases` matches `'be honest'` case-insensitively without altering the input text (acceptance item 4).
3. **Recommended, not ticket-mandated:** run `pnpm exec tsc --noEmit` (or `pnpm build`) once after all five source files are complete. Vitest's esbuild-based transpile does not fully type-check; this is cheap insurance against a malformed generic constraint (`filterByReferentialIntegrity<T extends { projectId: string }>`) or an incorrect `Record`/tuple type slipping through Vitest but breaking `next build`'s project-wide `tsc` pass — same recommendation FND-03/FND-06's plans made for their own generically-typed/const-asserted code.
4. **No file outside File-scope was touched**: `git diff --stat 7853c98..HEAD` (base commit confirmed in §0) should list exactly the 5 source files + 4 test files under `lib/validation/**` (9 files total, no `index.test.ts`). Anything else in the diff (in particular `lib/schemas/**`, `vitest.config.ts`, `tsconfig.json`, `package.json`, any `app/api/**` route) is a File-scope violation and must be reverted before merge.
5. All of the above are reproducible fully offline (no DB, no Anthropic API, no network, no live `DATABASE_URL`/`GLOBAL_DAILY_SPEND_LIMIT_USD`) — every function under test is pure, synchronous, and operates only on in-memory fixture data, consistent with the ticket's own Test plan framing ("No external fixtures/DB needed").

## 4. Risks & edge cases

- **Concurrency: no true multi-threading risk (Node.js is single-threaded, and every function here is synchronous with no `await`), but this ticket has one real shared-mutable-state hazard worth the Reviewer's attention: module-level `RegExp` objects constructed with the global (`g`) flag carry a persistent `lastIndex` property.** If `NUMERIC_TOKEN_REGEX` (`number-integrity.ts`) or any entry of `BLACKLIST_PATTERNS` (`blacklist.ts`) were scanned via a stateful `while ((m = regex.exec(text)))` loop instead of `String.prototype.matchAll`, a regex's `lastIndex` would persist across separate calls to the exported functions (since the regex is a module-level singleton, not re-constructed per call) — a **second, unrelated call** could silently start scanning from a non-zero offset, or (worse) `exec` against a *shorter* string than the one that left `lastIndex` non-zero would immediately return `null`, silently producing zero matches. This is exactly the kind of bug that would pass every single-call unit test in isolation yet fail intermittently once the module is used repeatedly in a live server process (e.g. `filterNumberIntegrity` called once for `TailoredResume.fullDraftMd`, then again moments later for a different job's draft, within the same Node.js process/module cache). §2.3/§2.4's implementations use `matchAll` exclusively for this reason (per the ECMAScript spec, `matchAll` operates on an internal clone of the regex and never mutates the caller's `lastIndex`) — **the Reviewer should specifically check that no `.exec()`/`.test()` loop was introduced against either module-level regex constant**, since that would reintroduce this hazard invisibly.
- **Security-sensitive path: this entire ticket implements PRD §5.5's stated trust boundary — every function here is the *last* line of defense before a stage's LLM output (or code-computed derivative of it) reaches a user-facing response.** The Reviewer should specifically check:
  - `filterByReferentialIntegrity`'s Set-membership check is exact-match, case-sensitive, with no fallback that could let a subtly-mismatched (hallucinated-looking) `projectId` slip through as "valid" (§2.1's explicit no-normalization instruction, pinned by a dedicated test in §2.6).
  - `ensureRequirementCoverage` and `filterByReferentialIntegrity` never mutate their input objects/arrays — a downstream route handler in FIT-02/TLR-01/PRP-02 may hold and reuse the original `Ledger`/`items` reference across further processing within the same request; silent mutation here would be a genuine, hard-to-diagnose correctness bug in a caller this ticket does not control (§2.1/§2.2 both defensively copy; §2.6 has an explicit purity test for `ensureRequirementCoverage`).
  - `filterNumberIntegrity`'s removal is index-based reconstruction, not `String.prototype.replace(token, '')` — the latter only replaces the *first* occurrence of a repeated token string, which would silently under-remove a fabricated number mentioned more than once in the same text (§2.3 explicitly calls this out; verify the Builder did not "simplify" to a replace-based approach during implementation).
  - `flagBlacklistedPhrases` truly never removes or alters text (PRD: "记录不阻断" — non-blocking by design) — check that no later convenience method or default parameter was added that turns this into an active filter; that would be a silent product-policy regression, not a bug fix, and is exactly the kind of scope creep the ticket's own Non-goals section anticipates ("non-blocking by design, so omission by a downstream ticket is a quality gap, not a correctness bug").
- **Layer 3's regex has documented, pre-declared blind spots — this plan states them up front rather than presenting the starting implementation as complete, per the ticket's own framing (Feedback obligation #3) that a false negative found later is P0-severity, not a silent-fix item:**
  1. No unit-aware numeric equivalence — `"$1.2M"` and `"$1,200,000"` are different tokens; a number restated in a different (but numerically equal) format between generated text and source will be incorrectly flagged as unsupported (false positive) or, if the source itself only has the "M" form and generated text fabricates the same number in decimal form, would not be caught as equivalent either way — this is a genuine gap, not just an inconvenience.
  2. No support for spelled-out numbers ("forty percent", "a million dollars").
  3. Currency symbols limited to `$`/`€`/`£` — no support for `USD 1.2M`-style prefix notation.
  4. No leading-minus-sign support — `"-12%"` extracts as token `"12%"`, leaving a stray `"-"` character in `result` if the number is dropped. This is a cosmetic gap, not a validation bypass: the numeric digits are still extracted, checked, and (if unsupported) removed; only the sign character is left behind in the text.
  5. Ordinals like `"3rd"` produce a benign false-positive token (`"3"`) since the suffix/lookahead design does not special-case ordinal indicators — accepted because erring toward over-flagging is directionally safer than under-flagging, per PRD's "数字永不虚构" (numbers must never be fabricated) principle; an occasional harmless ordinal getting checked against the source pool (and likely passing, since resume text rarely repeats bare ordinals as "metrics" the model would fabricate) is a much smaller risk than a fabricated number silently passing through.
  These are exactly the kind of gaps the ticket's Feedback obligation #3 anticipates TLR-01 discovering via real fixtures during `05-tailor`'s Q1/Q2 testing — this plan does not claim the starting regex is exhaustive, and the Builder should not either.
- **Layer 4's starter blacklist is a direct transcription of the ticket's own four named phrases** (not this plan's invention) — per Feedback obligation #2, expanding this list later is a product/config decision requiring a decision record (note in `01-foundation/README.md`'s open questions if it needs to change materially), not a silent code edit by whichever downstream ticket first notices the list feels short.
- **`Gap.play: ''` for injected gaps** (§2.2) is an explicit, ticket-mandated choice, not an oversight — flagged so a Reviewer doesn't "fix" it into some placeholder string; PRD gives no `play` value for a requirement the model never addressed at all, and inventing prose here would misrepresent that nothing was actually bridged.
- **Windows/cross-platform**: no OS-specific concern — every function in this ticket operates on in-memory strings/arrays/Sets with no filesystem, path, or process access. N/A, called out explicitly per this repo's established plan convention (FND-05/FND-06 did the same for their own files).

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Whether `filterNumberIntegrity`'s `result` text should get a whitespace-collapsing pass after a token is removed (avoiding a cosmetic double space where a dropped number sat mid-sentence). Ticket does not specify a formatting rule; this plan leaves it as a Builder judgment call, with no test depending on exact spacing. | Builder, at build time (low-stakes either way) — Reviewer may also flag a preference. |
| 2 | Whether `flagBlacklistedPhrases`'s curly-apostrophe (`'’'`) match on `"it's important to note"` (§2.4) is an appropriate, low-risk robustness addition beyond the ticket's literal string, or unrequested scope creep that should be reverted to a strict-literal match only. | Reviewer, at review time — one-line, trivially reversible either way; no cascading impact since nothing else in this ticket depends on the apostrophe variant. |
| 3 | Whether `UNCOVERED_MARKER` (exported from `requirement-coverage.ts`, re-exported via the barrel) should actually be part of this ticket's public surface, since the ticket's own Deliverable 5 import-surface example only lists the four function names (not this constant). This plan exports it anyway, reasoning that it directly serves the ticket's own Background instruction that FIT-02 "needs to check for this literal marker string" — better a shared constant than a re-typed literal in FIT-02. | Reviewer, at review time — if considered an unrequested-export deviation, trivially reversible (FIT-02 would instead hardcode the literal string itself, which the ticket's Background text already contemplates as an acceptable fallback). |
| 4 | Whether Layer 3's regex (§2.3, §4) needs hardening *before* TLR-01 starts, versus being accepted as a documented starting point per the ticket's own Feedback-obligation framing ("if the regex is found to have false negatives... during TLR-01's own Q1/Q2 fixture testing, that is a P0-severity quality gap... TLR-01 must fix the regex here"). This plan follows the ticket's explicit sequencing: ship the documented starting point now, harden later against real fixtures, not before they exist (`02-evaluation`'s fixture corpus does not exist yet — confirmed in §0/§2.6). | Ticket-mandated already (not actually open) — restated here only so the Reviewer does not mistake the pre-declared blind spots in §4 for an incomplete implementation; escalation path (TLR-01 fixes + EVL-01 regression fixture) is fixed by the ticket's own Feedback obligation #3, not this plan. |

## 6. ADR-candidate flag

**Not proposing a new ADR.** The ticket states this explicitly up front: "No ADR — the decision is already made in PRD §5.5 (the four validation layers, stated as a fixed list)." This plan's own contributions — the specific `NUMERIC_TOKEN_REGEX` pattern, the `UNCOVERED_MARKER` → `Gap.probe` mapping, and the four-phrase blacklist transcription — are all either (a) directly dictated by the ticket's own Deliverable text, or (b) a regex implementation detail the ticket itself frames as a "starting point" explicitly expected to be hardened later by TLR-01 against real fixtures (Feedback obligation #3), i.e. cheap-to-reverse tuning, not a hard architectural lock-in comparable to e.g. FND-03's `Ledger.bindings`/`gaps` disjoint-union shape (which *was* flagged in FND-03's plan as the one shape decision with real downstream leverage, but still judged not ADR-worthy on its own, per that ticket's own text). No ADR is proposed by this plan.
