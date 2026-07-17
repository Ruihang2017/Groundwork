# Implementation plan — FND-03: Pipeline stage payload Zod schemas

Ticket: [docs/prd/01-foundation/tickets/FND-03-pipeline-payload-schemas.md](../prd/01-foundation/tickets/FND-03-pipeline-payload-schemas.md)
Sub-PRD: [docs/prd/01-foundation/README.md](../prd/01-foundation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §5.1 (stage table), §5.2 (Fit Report), §5.3 (Tailor), §5.4 (Prep), §5.5 (trust boundary), §5.6 (data model — names these types by reference)
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md)
Depends on (merged): [docs/plans/FND-01.md](FND-01.md) (repo/toolchain), [docs/plans/FND-02.md](FND-02.md) (core entity schemas — sibling, not a hard dependency; FND-03's `blocked_by` is only FND-01)

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline`: `fca5058` (merge ticket/FND-02 into main), `6a1e590` (FND-02), `9c8f7e1` (merge FND-01), `fc6d27a`/`5287044` (FND-01), `ecb55a8` (bootstrap). `git branch -a` shows `main`, `ticket/FND-01`, `ticket/FND-02`, `remotes/origin/main` — **no `ticket/FND-03` branch exists yet**. Working tree clean, `main` up to date with `origin/main`.
- `zod` is **already** an installed runtime dependency: `package.json` `"dependencies"` has `"zod": "^4.4.3"`, and `node_modules/zod/package.json` resolves to exactly `4.4.3`. **No `package.json`/`pnpm-lock.yaml` change is needed for this ticket** — FND-02 already added `zod` to the shared, append-only `package.json`. Do not re-add it or touch the lockfile.
- `vitest.config.ts` currently reads:
  ```ts
  import { fileURLToPath } from 'node:url';
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
    },
  });
  ```
  `include` already covers `lib/**/*.test.ts` — this was FND-02's writeback (v0.3 changelog entry in `01-foundation/README.md`), done specifically so that FND-03/04/06/07/10's colocated `lib/**` test files would not each need to re-touch this shared file. **`lib/schemas/pipeline.test.ts` is already reachable by this glob — no `vitest.config.ts` change needed in this ticket.**
- `tsconfig.json`'s `include` is `["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "tests/**/*.ts"]` — `**/*.ts` already covers a future `lib/schemas/pipeline.ts` and `lib/schemas/pipeline.test.ts` for both `tsc`/`next build` type-checking and the `@/*` → repo-root path alias. **No tsconfig change needed.**
- `eslint.config.mjs` applies `next/core-web-vitals` + `next/typescript` globally except `.next/**`, `node_modules/**`, `out/**`, `build/**`, `next-env.d.ts` — `lib/**` is linted by default already. **No eslint config change needed.**
- `lib/schemas/entities.ts` (FND-02, merged) exists and exports `Profile`, `Project`, `PROJECT_ID_PATTERN`, `Library`, `Resume` plus inferred types. Confirmed by direct read: **nothing in `entities.ts` is imported by this ticket** — per the ticket's own Non-goals, `pipeline.ts` must not import from `entities.ts` (keeps the two sibling schema files independent, per `01-foundation/README.md`'s decisions table row 1: "Zod schema 按…两个独立文件/票据，互不 import，都只依赖 FND-01"). Any `Project`/`projectId` reference in this ticket's schemas is a plain `z.string()`, validated against the library at runtime by FND-07 — not by cross-schema Zod composition.
- Installed `zod@4.4.3`'s type declarations confirm the API surface every Deliverable in the ticket needs is present: `node_modules/zod/v4/classic/schemas.d.ts` — `ZodArray.length(len, params?)` (lines 97, 442) for `Rehearse.questions`/`askThem`; `.max()`/`.min()` on arrays and numbers; `z.enum(...)`; `z.union([...])`; `z.literal(...)`; `.optional()`. No zod upgrade or API workaround is needed.
- Serial-safety: per `docs/prd/breakdown-plan.md`'s lane-serial-execution note, tickets within `01-foundation` execute strictly serially by `blocked_by`/numeric order. FND-01 and FND-02 are merged. FND-03's own ticket file states its only hard dependency is FND-01 (merged) and that FND-02 "may be in flight in parallel within the same lane... but writes a disjoint file" — in this repo's actual history FND-02 is already merged, so there is no live contention at all: FND-03 has exclusive, uncontended access to every file in its File-scope.

## 1. Scope

**In scope:**
- New file `lib/schemas/pipeline.ts` exporting Zod v4 schemas (and inferred TS types) for every type named in the ticket's Deliverables 1–17: `RequirementCategory`, `JdExtract`, `BindingStrength`, `Binding`, `Gap`, `Ledger`, `HardRequirementCheck`, `SubScore`, `FitTier`, `FitReport`, `AlignmentEntry`, `Alignment`, `Edit`, `IntelRecentItem`, `Intel`, `RehearseQuestion`, `Rehearse` — plus Deliverable 18's `export type X = z.infer<typeof X>` pair for each.
- New file `lib/schemas/pipeline.test.ts` — Vitest unit tests, one `describe` block per schema, covering every acceptance-checklist item plus a valid-object happy path per schema (per the ticket's own Test plan).
- Array-length/enum/numeric-range constraints encoded directly in the schemas wherever PRD gives a concrete number or enum (§5.1's "≤ 11", "1–3", "≤ 3"; §5.2's "0–100" and the four-tier enum; §5.4's "questions[5]" / "askThem[3]").

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):
- `Project`/`Library`/`Resume`/`Profile` (FND-02, already merged) — do not import from `lib/schemas/entities.ts`; any "project reference" field in this ticket's schemas is a plain `z.string()`.
- `Job`/`TailoredResume`/`Brief` (the persisted wrappers that embed these pipeline types) — FND-04, blocked on this ticket, comes next.
- Any actual LLM prompt text, API call code, or stage-invocation logic — that is FIT-01/02, TLR-01, PRP-01/02's own tickets. This ticket is the output *contract* only.
- SCORE computation logic (the deterministic function producing `FitReport` from `Ledger`) — FIT-02. This ticket only defines `FitReport`'s shape.
- Any change to `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, or `tsconfig.json` — confirmed in §0 that none of the ticket's acceptance criteria require touching any of them this time (unlike FND-02, which had to widen `vitest.config.ts`'s `include`). Do not touch these files.
- Any change to `lib/schemas/entities.ts` — read-only awareness of its existence, no import, no edit.

## 2. Change list

### 2.1 `lib/schemas/pipeline.ts` (new file)

Named exports (not default). Write in the dependency order below so later schemas can reference earlier ones in the same file (top-to-bottom, no forward references needed):

1. **`RequirementCategory`**
   ```ts
   export const RequirementCategory = z.enum(['technical', 'experience', 'domain', 'logistics']);
   export type RequirementCategory = z.infer<typeof RequirementCategory>;
   ```
   Source: PRD §5.1 READ row — "每条打 category（technical / experience / domain / logistics）".

2. **`JdExtract`**
   ```ts
   export const JdExtract = z.object({
     requirements: z
       .array(
         z.object({
           id: z.string(),
           text: z.string(),
           weight: z.union([z.literal(1), z.literal(2), z.literal(3)]),
           category: RequirementCategory,
         }),
       )
       .max(11),
     atsKeywords: z.array(z.string()),
     subtext: z.array(z.string()).max(3),
   });
   export type JdExtract = z.infer<typeof JdExtract>;
   ```
   Source: PRD §5.1 READ row — "requirements ≤ 11、weight 1–3（3 = 没有就不招）...atsKeywords 列表；subtext ≤ 3". `requirements[].id` exists so `Ledger`'s `Binding`/`Gap` (below) can reference a specific requirement by id (`requirementId`) — this is the join key between READ's output and CROSS's output; do not drop it, even though the ticket's PRD-quote for `JdExtract` does not spell out "id" in prose — it is explicit in Deliverable 2's code and required for `Binding`/`Gap.requirementId` to mean anything.

3. **`BindingStrength`**
   ```ts
   export const BindingStrength = z.enum(['strong', 'partial']);
   export type BindingStrength = z.infer<typeof BindingStrength>;
   ```
   Source: PRD §5.1 SCORE row — "strong=1 / partial=0.5 / gap=0". `gap` is deliberately excluded from this enum — see `Ledger` below (a `strength: 'gap'` binding is not how "gap" is represented; it lives in the separate `gaps` array). This is a load-bearing shape decision — see §4 Risks and the ticket's own Feedback obligation #2.

4. **`Binding`**
   ```ts
   export const Binding = z.object({
     requirementId: z.string(),
     projectId: z.string(),
     strength: BindingStrength,
     evidence: z.string(),
   });
   export type Binding = z.infer<typeof Binding>;
   ```
   Source: PRD §5.1 CROSS row ("binding 必须引用库条目中的具体技术细节") + §5.5 layer 1 ("`projectId ∈ library`"). `projectId` is a plain `z.string()` — **not** cross-validated against `lib/schemas/entities.ts`'s `Project.id`/`PROJECT_ID_PATTERN` in this schema. Runtime referential-integrity checking against the actual library is FND-07's job (§5.5 layer 1), not this ticket's. Do not add a `.regex(PROJECT_ID_PATTERN, ...)` constraint here even though it would be tempting — that would require importing from `entities.ts`, which the ticket's Non-goals explicitly forbid.

5. **`Gap`**
   ```ts
   export const Gap = z.object({
     requirementId: z.string(),
     probe: z.string(),
     play: z.string(),
   });
   export type Gap = z.infer<typeof Gap>;
   ```
   Source: PRD §5.1 CROSS row — "gap 必须给 probe（他们会怎么问）+ play（具体桥接话术）".

6. **`Ledger`**
   ```ts
   export const Ledger = z.object({
     bindings: z.array(Binding),
     gaps: z.array(Gap),
   });
   export type Ledger = z.infer<typeof Ledger>;
   ```
   Source: PRD §5.1 CROSS row — "每条 requirement 恰好落入 bindings ∪ gaps 之一" — a disjoint union encoded as two arrays, not a single tagged array. This shape (not `Array<Binding | Gap>` with a discriminant) is the ticket's explicit design decision (Background, final paragraph) — do not restructure it into a single unioned array; that would silently change a shape FND-07 (layer 2, requirement-coverage checking) is depended on to read.

7. **`HardRequirementCheck`**
   ```ts
   export const HardRequirementCheck = z.object({
     label: z.string(),
     status: z.enum(['pass', 'fail', 'unknown']),
   });
   export type HardRequirementCheck = z.infer<typeof HardRequirementCheck>;
   ```
   Source: PRD §5.2 — "硬性条件（签证 / 地点 / 年限 / 语言）逐条 pass / fail / unknown，置顶展示". `label` holds which hard requirement this is (e.g. "visa", "location", "years", "language") — PRD does not fix these four as a closed enum of label strings (only as the four *kinds* of hard requirement to check), so `label` stays `z.string()`, not a 4-value enum; this is a plain, low-risk reading with no PRD text to the contrary.

8. **`SubScore`**
   ```ts
   export const SubScore = z.object({
     score: z.number().min(0).max(100),
     bindings: z.array(z.string()),
     gaps: z.array(z.string()),
   });
   export type SubScore = z.infer<typeof SubScore>;
   ```
   Source: PRD §5.2 — "四个子分（0–100）...各自列出支撑 bindings 与 gaps，分数可下钻到证据". Per Deliverable 8, `bindings`/`gaps` hold `requirementId` strings (or `Binding`/`Gap` array-index references — the ticket explicitly leaves the exact indexing convention to FIT-02's implementation, only fixing that both arrays exist and are `z.array(z.string())`-shaped at the schema level). Do not narrow this to a more specific shape than the ticket states — that decision belongs to FIT-02.

9. **`FitTier`**
   ```ts
   export const FitTier = z.enum(['Strong', 'Competitive', 'Stretch', 'Long shot']);
   export type FitTier = z.infer<typeof FitTier>;
   ```
   Source: PRD §5.2 — "≥75 Strong / 55–74 Competitive / 35–54 Stretch / <35 Long shot". Note the literal string `'Long shot'` contains a space — transcribe exactly as PRD/ticket state it (this is also directly asserted by acceptance-checklist item 6: "`FitReport.tier` only accepts the four literal PRD tier strings").

10. **`FitReport`**
    ```ts
    export const FitReport = z.object({
      hardRequirements: z.array(HardRequirementCheck),
      subScores: z.object({
        technical: SubScore,
        experienceDepth: SubScore,
        domain: SubScore,
        evidenceStrength: SubScore,
      }),
      compositeScore: z.number().min(0).max(100),
      tier: FitTier,
      advice: z.string(),
      topGaps: z.array(Gap),
    });
    export type FitReport = z.infer<typeof FitReport>;
    ```
    Source: PRD §5.2 in full — hard requirements, four named sub-scores (技术栈匹配→`technical`, 经验深度→`experienceDepth`, 领域匹配→`domain`, 证据强度→`evidenceStrength`), composite score + tier, "档位给建议语 + top gaps（含 probe/play）" → `advice` + `topGaps: z.array(Gap)` (reusing `Gap`, which already carries `probe`/`play`).

11. **`AlignmentEntry`**
    ```ts
    export const AlignmentEntry = z.object({
      keyword: z.string(),
      status: z.enum(['present', 'missing_in_resume', 'missing_in_library', 'synonym_mismatch']),
      note: z.string().optional(),
    });
    export type AlignmentEntry = z.infer<typeof AlignmentEntry>;
    ```
    Source: PRD §5.3 — "JD 关键词 → 简历中 present / missing / 同义失配...missing 区分两类：库里有、简历没写...库里也没有". Four-value enum per Deliverable 11's explicit rationale (encodes the two-way missing split as distinct enum values rather than requiring downstream code to re-derive it).

12. **`Alignment`**
    ```ts
    export const Alignment = z.array(AlignmentEntry);
    export type Alignment = z.infer<typeof Alignment>;
    ```
    Note: `Alignment` is a bare array schema (`z.array(...)`), not a `z.object({...})` wrapper — matches Deliverable 12 and PRD §5.6's reference (`TailoredResume.alignment: Alignment`) exactly as-is; do not wrap it in an object.

13. **`Edit`**
    ```ts
    export const Edit = z.object({
      original: z.string(),
      suggested: z.string(),
      rationale: z.string(),
      projectId: z.string(),
    });
    export type Edit = z.infer<typeof Edit>;
    ```
    Source: PRD §5.3 — "`{原文, 建议改写, 理由, 来源 projectId}`". Same `projectId: z.string()` treatment as `Binding` (see item 4) — no cross-import, no regex constraint, runtime check is FND-07's job.

14. **`IntelRecentItem`**
    ```ts
    export const IntelRecentItem = z.object({
      headline: z.string(),
      soWhat: z.string(),
    });
    export type IntelRecentItem = z.infer<typeof IntelRecentItem>;
    ```
    Source: PRD §5.1 RESEARCH row — "recent ≤ 3（每条带 soWhat）" implies each recent item has at least a headline/description plus its `soWhat`; `headline` is this plan's minimal reasonable field name for "the recent item's content itself" (PRD does not name this sub-field beyond "每条…带 soWhat", so the item needs *some* content field distinct from `soWhat` — `headline` is the natural, low-risk choice; flagged in §5 Open Questions as a naming call, not a shape gap).

15. **`Intel`**
    ```ts
    export const Intel = z.object({
      snapshot: z.string(),
      recent: z.array(IntelRecentItem).max(3),
      engineeringSignals: z.array(z.string()).max(3),
      talkingPoints: z.array(z.string()).max(3),
    });
    export type Intel = z.infer<typeof Intel>;
    ```
    Source: PRD §5.1 RESEARCH row — "snapshot、recent ≤ 3（每条带 soWhat）、engineering 信号 ≤ 3、talkingPoints ≤ 3；查无实据返回空数组，禁止编造". "查无实据返回空数组" (empty array is valid when nothing is found) is naturally satisfied because `.max(3)` alone permits zero-length arrays — do not add `.min(1)` anywhere in this schema; that would directly contradict this PRD sentence and break acceptance-checklist item 5.

16. **`RehearseQuestion`**
    ```ts
    export const RehearseQuestion = z.object({
      projectId: z.string(),
      question: z.string(),
      trap: z.string().min(1),
    });
    export type RehearseQuestion = z.infer<typeof RehearseQuestion>;
    ```
    Source: PRD §5.4 — "每个问题必须绑 projectId...trap = 标准答案之后的第二问". `trap: z.string().min(1)` per Deliverable 16's explicit instruction ("`trap` non-empty is enforced with `.min(1)`, matching PRD's 'trap 非空' requirement referenced in §6 Q1") — verify this exact phrase's presence in PRD §6 at implementation time (see §5 Open Questions #1 below; the ticket cites it, this plan does not re-verify PRD §6's literal text since Deliverable 16 already states the requirement precisely enough to implement without ambiguity).

17. **`Rehearse`**
    ```ts
    export const Rehearse = z.object({
      questions: z.array(RehearseQuestion).length(5),
      askThem: z.array(z.string()).length(3),
      positioning: z.string(),
    });
    export type Rehearse = z.infer<typeof Rehearse>;
    ```
    Source: PRD §5.4 / §5.1 REHEARSE row — "questions[5] + askThem[3] + positioning". Exactly 5 / exactly 3 via `.length()`, not `.max()` — confirmed available on installed `zod@4.4.3` (§0).

File-level import: `import { z } from 'zod';` only. No import from `lib/schemas/entities.ts` (see §0/Non-goals). No import from anywhere else in the repo (this is a leaf schema file, same as `entities.ts`).

### 2.2 `lib/schemas/pipeline.test.ts` (new file)

Vitest unit tests, pattern-matched to `lib/schemas/entities.test.ts`'s (FND-02, merged) `describe`/`it`/`expect` style and import convention — copy that file's construction pattern (plain `describe(...)` blocks per schema, `Schema.parse(...)`/`.safeParse(...).success` assertions, no fixtures/mocks, hand-built inline valid objects). Import from `@/lib/schemas/pipeline` (repo-root alias, already live).

```ts
import { describe, expect, it } from 'vitest';

import {
  Alignment,
  AlignmentEntry,
  Binding,
  BindingStrength,
  Edit,
  FitReport,
  FitTier,
  Gap,
  HardRequirementCheck,
  Intel,
  IntelRecentItem,
  JdExtract,
  Ledger,
  Rehearse,
  RehearseQuestion,
  RequirementCategory,
  SubScore,
} from '@/lib/schemas/pipeline';
```

One `describe` block per schema (17 total, matching Deliverables 1–17; `RequirementCategory`/`BindingStrength`/`FitTier` can each get a short dedicated block or be folded into the `describe` of the schema that uses them — prefer dedicated blocks for direct enum-membership assertions per acceptance item 6). Required coverage, mapped 1:1 to the ticket's acceptance checklist:

1. **`JdExtract`**
   - Valid object with exactly 11 `requirements` parses.
   - A 12th `requirements` entry (array of 12) is rejected — `.safeParse(...).success === false` (acceptance item 1).
   - `weight: 4` is rejected; `weight: 1`, `weight: 2`, `weight: 3` each accepted (acceptance item 2) — four separate assertions or one parameterized `it.each`.
   - `subtext` with 4 entries is rejected (mirrors the `.max(3)` constraint, not itself a named acceptance item but directly asserts a stated Deliverable constraint — include for completeness, matching the ticket's Test-plan instruction to assert "each stated constraint").
   - `category` accepts all four `RequirementCategory` values and rejects a fifth string.

2. **`Ledger`/`Binding`/`Gap`**
   - Valid `Ledger` with one `Binding` (`strength: 'strong'`) and one `Gap` parses.
   - `BindingStrength` rejects `'gap'` as a value (proves the disjoint-union design: "gap" is never a binding strength) — this is not a literal acceptance-checklist line item, but is directly load-bearing per the ticket's Background/Feedback-obligation #2 language; assert it explicitly so a future accidental widening of the enum is caught by the suite.
   - `Binding.strength` rejects an arbitrary string outside `{'strong','partial'}`.

3. **`FitReport`**
   - Valid object with all four `subScores` keys (`technical`, `experienceDepth`, `domain`, `evidenceStrength`) parses.
   - `SubScore.score` rejects `-1` and `101` (min/max 0–100).
   - `FitReport.compositeScore` rejects `-1` and `101`.
   - `FitReport.tier` accepts each of the four literal strings (`'Strong'`, `'Competitive'`, `'Stretch'`, `'Long shot'`) and rejects a fifth arbitrary string, e.g. `'Excellent'` (acceptance item 6).

4. **`Alignment`/`AlignmentEntry`**
   - Valid `Alignment` array (bare array, not object-wrapped) with entries covering all four `status` values parses.
   - `AlignmentEntry.status` rejects a value outside the four-item enum.
   - `AlignmentEntry.note` omitted parses (optional).

5. **`Edit`**
   - Valid object with all four required string fields parses.

6. **`Intel`**
   - Valid object with 3 `recent`/`engineeringSignals`/`talkingPoints` entries parses.
   - Empty arrays for all three (`recent: []`, `engineeringSignals: []`, `talkingPoints: []`) parse without throwing — explicit assertion this is a valid state (acceptance item 5, "查无实据返回空数组").
   - A 4th item in each of the three arrays is rejected — three separate assertions (acceptance item 5's reject half).

7. **`Rehearse`/`RehearseQuestion`**
   - Valid object with exactly 5 `questions` and exactly 3 `askThem` parses.
   - `questions` arrays of length 4 and length 6 are both rejected (acceptance item 3).
   - `askThem` arrays of length 2 and length 4 are both rejected (acceptance item 3).
   - `RehearseQuestion.trap: ''` (empty string) is rejected (acceptance item 4).

No test should reference `fixtures/**` (does not exist yet — `02-evaluation` builds it later; the ticket's Test plan explicitly forbids this, matching FND-02's precedent).

### 2.3 No writeback to `01-foundation/README.md` or shared config files expected

Unlike FND-02 (which had to widen `vitest.config.ts`'s `include` and therefore bump its own ticket version + the sub-PRD changelog), this ticket's §0 check confirms `vitest.config.ts`, `tsconfig.json`, `eslint.config.mjs`, and `package.json` all already support this ticket's needs with zero changes. **Do not preemptively add a changelog entry** — only do so if implementation actually falsifies something in this plan or the ticket (per the ticket's Feedback obligation #1's general rule: "if a stage's actual LLM output... needs a field this ticket didn't anticipate... version +0.1, changelog line"). If the Builder discovers something in §0 has drifted since this plan was written (re-check `git log`/`git status` first, per standard practice), treat that as a real finding and follow the ticket's Feedback obligation, not this plan's assumption.

## 3. Test plan

Maps directly to the ticket's acceptance checklist; each item is what the Builder/Reviewer actually runs.

1. **`pnpm test` exits 0** and output includes `lib/schemas/pipeline.test.ts`'s suite alongside the existing `tests/smoke.test.ts` and `lib/schemas/entities.test.ts` suites (three files total contributing passing tests) — confirms `vitest.config.ts`'s already-widened `include` picks up the new file with no further config change (§0/§2.3).
2. **Targeted assertions**, all covered by §2.2's test file — re-verify each is actually present and actually exercised:
   - `JdExtract` rejects a 12th `requirements` entry (acceptance item 1).
   - `JdExtract` rejects `weight: 4`, accepts `weight: 1|2|3` (acceptance item 2).
   - `Rehearse` rejects `questions` of length 4 or 6, and `askThem` not of length 3 (acceptance item 3).
   - `RehearseQuestion.trap` rejects `''` (acceptance item 4).
   - `Intel.recent`/`.engineeringSignals`/`.talkingPoints` each accept `[]` and reject a 4th item (acceptance item 5).
   - `FitReport.tier` only accepts the four literal tier strings (acceptance item 6).
3. **Recommended, not ticket-mandated:** run `pnpm build` (or `pnpm exec tsc --noEmit`) once after adding `pipeline.ts`. Vitest's esbuild-based transpile does not perform full TypeScript type-checking, so a type error (e.g. a malformed `z.infer` reference, or an accidental circular reference between `Gap`/`Ledger`/`FitReport`) could pass `pnpm test` while still breaking `next build`'s project-wide `tsc` pass. Not a formal acceptance item, but cheap insurance — flag any failure here to the Reviewer even though it's outside the ticket's literal checklist (mirrors FND-02's plan §3 item 4 precedent).
4. **No file outside File-scope was touched**: `git diff --stat fca5058..HEAD` (base = the FND-02 merge commit, confirmed current `main` HEAD in §0) should list exactly `lib/schemas/pipeline.ts` and `lib/schemas/pipeline.test.ts`. Anything else in the diff (in particular `package.json`, `pnpm-lock.yaml`, `vitest.config.ts`, `tsconfig.json`, `lib/schemas/entities.ts`) is a File-scope violation and must be reverted before merge, per §2.3's expectation that no shared-file writeback is needed this time.
5. All of the above are reproducible fully offline (no DB, no Anthropic API, no network) — pure schema-parsing unit tests, consistent with the ticket's own Test plan framing.

## 4. Risks & edge cases

- **Concurrency: none applies.** `lib/schemas/pipeline.ts` is a pure, side-effect-free module — schema object literals evaluated once at import time, no I/O, no shared mutable state, no async code, no request-handling. There is nothing here that can race. (Same category of finding as FND-02's plan §4 — carried forward because the file shape is identical in kind.)
- **Security-sensitive path: this file is part of PRD §5.5's trust boundary, even though it contains no request-handling code itself.** PRD §5.5: "所有 stage 输出先过 Zod v4 schema，再执行四层过滤" — every schema in this file is the *first* line of defense for every LLM-produced stage payload (READ/CROSS/RESEARCH/REHEARSE) and every code-computed payload (SCORE/TAILOR-adjacent `Alignment`/`Edit`). A schema that's too loose here doesn't cause a runtime bug in this ticket, but silently weakens every downstream feature module's (FIT-01/02, TLR-01, PRP-01/02) input-validation boundary. The Reviewer should specifically check:
  - `JdExtract.requirements` is actually capped at 11 (not "≤ 11 by convention, enforced elsewhere") — a model that returns 15 requirements must be rejected by `.parse()`, not silently truncated by later code.
  - `Ledger`'s `bindings`/`gaps` split has no accidental `strength: 'gap'` escape hatch — `BindingStrength` must reject `'gap'` (§2.2 test item 2's second bullet exists specifically to pin this).
  - No field was widened beyond what PRD/the ticket state (e.g. `FitReport.tier` must be a closed 4-value enum, not `z.string()`; `compositeScore`/`SubScore.score` must be bounded 0–100, not an open `z.number()`).
  - `projectId`/requirement-reference fields (`Binding.projectId`, `Edit.projectId`, `RehearseQuestion.projectId`, `Binding.requirementId`, `Gap.requirementId`) are intentionally **unconstrained** `z.string()` at this layer (no regex, no cross-schema reference check) — this is correct per the ticket's Non-goals (FND-07 owns the actual referential-integrity check against the live library, §5.5 layer 1), but it means this schema file alone provides **no protection** against a hallucinated `projectId` that doesn't exist in any library. Flag this explicitly to the Reviewer as an intentional, ticket-mandated gap — not an oversight — so it isn't mistaken for a missed constraint.
- **`Ledger`'s disjoint-union shape (`bindings: Binding[]` + `gaps: Gap[]`, not a single tagged array) is the one hard-to-reverse-ish shape decision in this ticket**, per the ticket's own Background (final paragraph) and Feedback obligation #2. It is explicitly called out in the ticket as *not* ADR-worthy on its own (the ticket states "No ADR — the decision is already made in PRD §5.1–§5.4"), but the ticket itself flags that if FND-07's layer-2 requirement-coverage validation later needs a different shape, that change must go through ticket + `01-foundation/README.md` decisions-table update, with an explicit flag to Horace — not a silent swap. This plan does not deviate from the ticket's prescribed shape; flagged here only so the Reviewer is aware of the provenance and doesn't second-guess it as an arbitrary choice.
- **`IntelRecentItem.headline` field name is this plan's inference, not literally named in PRD §5.1's RESEARCH row prose** ("recent ≤ 3（每条带 soWhat）" only names `soWhat` explicitly). The ticket's Deliverable 14 code snippet does supply `headline` as the field name, so this is not actually a plan-level judgment call — it's transcription of Deliverable 14 as written. Included in Risks only to make explicit that if a downstream ticket (RESEARCH's actual implementation, PRP-01) finds the LLM naturally produces a different natural field name (e.g. `title`), that is exactly the "actual LLM output needs a field this ticket didn't anticipate" case the ticket's Feedback obligation #1 already covers — extend `pipeline.ts` directly, bump the ticket version, don't rename `headline` silently mid-stream once other code depends on it.
- **No `.min(1)` anywhere in `Intel`'s three capped arrays is intentional, not an oversight** — PRD §5.1 RESEARCH row explicitly states "查无实据返回空数组，禁止编造" (return an empty array when nothing is found; do not fabricate). Flagged so the Reviewer doesn't "fix" this into a `.min(1)` — that would directly contradict PRD and break acceptance-checklist item 5's accept-empty-array half.
- **`FitTier`'s `'Long shot'` literal contains a space.** Low risk but worth flagging: any code that later does string interpolation, URL-building, or CSS class naming off this literal must handle the embedded space (e.g. not naively use it as a CSS class or query-param without encoding). Not this ticket's problem to solve (that's UI-layer, later modules) — flagged for downstream awareness only.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | Deliverable 16 cites "matching PRD's 'trap 非空' requirement referenced in §6 Q1" for `RehearseQuestion.trap`'s `.min(1)` constraint — this plan implements exactly what Deliverable 16 states (`.min(1)`) without independently re-deriving or re-verifying PRD §6 Q1's literal wording, since the ticket's own Deliverable text is unambiguous and authoritative for this ticket's purposes. If a future audit finds PRD §6 doesn't actually say this, that's a ticket-vs-PRD accuracy question, not an implementation gap — the schema is written to be correct if the ticket's own accurate. | Whoever last touches `01-foundation/README.md`'s decisions table if a discrepancy surfaces — likely Horace, since it would mean re-reading PRD §6 against the ticket text; not blocking for this ticket's implementation since Deliverable 16 is unambiguous on its face. |
| 2 | `IntelRecentItem.headline`'s exact field name (see §4 Risks) — this plan follows the ticket's Deliverable 14 code snippet literally; flagged only as a forward-looking naming-drift watch item, not an open decision for this ticket. | RESEARCH's implementer (PRP-01/02), if real LLM output naturally suggests a different name — follow the ticket's Feedback obligation #1 (extend `pipeline.ts`, bump ticket version) rather than treating it as this ticket's open item. |
| 3 | `HardRequirementCheck.label`'s type (`z.string()`, not a closed enum of the four hard-requirement kinds) — this plan's reading is that PRD names the four *kinds* to check (visa/location/years/language) as prose guidance for what SCORE must produce, not as a closed schema-level enum of label strings, so `z.string()` is the correct, least-presumptuous encoding. | Reviewer, at review time — low-stakes, one-line change to `z.enum(['visa','location','years','language'])` if disagreed with; no cascading impact since nothing else in this ticket depends on `label`'s exact type. |

## ADR-candidate flag

None of this ticket's choices rise to ADR-worthy (hard-to-reverse architectural decision) status, and the ticket file itself states this explicitly up front ("No ADR — the decision is already made in PRD §5.1–§5.4"). The one shape decision with real downstream leverage — `Ledger`'s `bindings`/`gaps` disjoint-union-via-two-arrays split (§4) — is already PRD-grounded (the "恰好落入 bindings ∪ gaps 之一" phrasing) and the ticket itself prescribes the exact correction path if it later proves wrong (ticket + `01-foundation/README.md` update, flag to Horace, no silent swap) rather than requiring a standalone ADR. No ADR is proposed by this plan.
