# Implementation plan — EVL-01: Fixture corpus — 10 JDs and 3 resumes

Ticket: [docs/prd/02-evaluation/tickets/EVL-01-fixture-corpus.md](../prd/02-evaluation/tickets/EVL-01-fixture-corpus.md)
Sub-PRD: [docs/prd/02-evaluation/README.md](../prd/02-evaluation/README.md)
Master spec: [docs/PRD.md](../PRD.md) §6 (fixtures spec — the load-bearing quote, reproduced below), §4 (target persona: English-market SWE/AI/Data job seekers), §5.1 (READ stage row: `requirements ≤ 11`, `weight 1–3`, category enum `technical/experience/domain/logistics`, `atsKeywords`, `subtext ≤ 3` — what the JD fixtures must contain enough signal to exercise), §5.6 (`Project.metrics: z.array(z.string())` — "空数组是合法且被显式展示的状态", the empty-metrics contract the resume fixtures must give `03-library`/LIB-03 something real to render against), §5.8 (v1 officially supports English JDs only)
Breakdown plan file-ownership table: [docs/prd/breakdown-plan.md](../prd/breakdown-plan.md) line 54 (`fixtures/**`, `eval/**`, `scripts/eval.mjs` → `02-evaluation`, "不与任何 `app/**` 或 `lib/**`（除只读 import）重叠")
Depends on (merged): none — `blocked_by: []`, greenfield path, no prior ticket has touched `fixtures/**`.
Downstream (read this plan's decisions before starting): EVL-02 (`eval/fixtures.ts`'s `loadFixtures()` reads `fixtures/manifest.json` and must match this plan's `file`-path convention — §2.6 below), LIB-01 (`[fixture]` acceptance item feeds the 3 resume fixtures through the PARSE route as pasted-plain-text; mocks the Anthropic call, so the resumes' literal prose is not machine-parsed by LIB-01's own tests, only structurally referenced), FIT-01/FIT-02 (Q1/Q2 acceptance criteria run against this corpus including the two adversarial JDs specifically, per PRD §6's Q1/Q2 gates)

This plan is cold-startable: a Builder with no access to the planning conversation can execute it from this file plus the ticket alone.

## 0. Repo-state check performed for this plan (do not re-derive, just confirm unchanged)

Verified at planning time (2026-07-18) by direct inspection, not assumption:

- `git log --oneline -5` / `git status`: HEAD is `64f8f41` ("Merge ticket/FND-10 into main: usage recording helper..."), branch `main`, working tree clean, up to date with `origin/main`. **`64f8f41` is the base commit** the Builder's diff should be measured against. `git branch -a` shows `main`, `ticket/FND-01` … `ticket/FND-10`, `remotes/origin/main` — **no `ticket/EVL-01` branch exists yet**.
- `fixtures/` **does not exist anywhere in the repo** (confirmed by directory listing at repo root) — this ticket creates it from scratch: `fixtures/jds/*.md` (10 files), `fixtures/resumes/*.md` (3 files), `fixtures/manifest.json`, `fixtures/manifest.test.ts`.
- **`vitest.config.ts`'s `test.include` does not cover `fixtures/**`** — confirmed by direct read: the array is exactly `['tests/**/*.test.ts', 'lib/**/*.test.ts', 'db/**/*.test.ts', '*.test.ts', 'app/**/*.test.{ts,tsx}']`. None of these five globs matches `fixtures/manifest.test.ts`. This is a **blocking gap**, not a nice-to-have: the ticket's own Test plan section names `fixtures/manifest.test.ts` as the test file, and acceptance item 5 requires "`pnpm test` green" to actually cover it. Without widening this list, `pnpm test` would exit 0 while **silently never running this file** — precisely the "false-green" failure mode `vitest.config.ts`'s own header comment documents, and which FND-02 (widened for `lib/**`), FND-05 (`db/**`), FND-06, FND-08 (`*.test.ts`), and FND-09 (`app/**/*.test.{ts,tsx}`) each fixed for their own new test locations. §2.7 below adds the one missing glob entry, following that exact precedent.
- `tsconfig.json`'s `include` (`"**/*.ts"`, confirmed by direct read) already covers `fixtures/manifest.test.ts` with no config change needed — same finding pattern as every prior ticket.
- `package.json`'s `"test": "vitest run"` script is unaffected; no new dependency is needed anywhere in this ticket (the test file uses only `node:fs`, `node:path`, `node:url`, and `vitest`, all already available). **No `package.json`/`pnpm-lock.yaml` change.**
- `eslint.config.mjs` only extends `next/core-web-vitals` / `next/typescript` and ignores `.next/**`, `node_modules/**`, `out/**`, `build/**`, `next-env.d.ts` — it lints `.ts`/`.tsx` files (so `fixtures/manifest.test.ts` is linted like any other test file) but has no rule touching `.md` content, so the 13 fixture markdown files are not lint-checked (expected — they are content, not code).
- `.gitignore` has no entry that would exclude `fixtures/**` or `*.md` — confirmed by direct read.
- Precedent for the test file's repo-root resolution pattern: `tests/toolchain.test.ts` and `tests/deploy-vercel.test.ts` (both one directory level below repo root, same depth as `fixtures/` will be) use `const repoRoot = fileURLToPath(new URL('..', import.meta.url))` — independent of `process.cwd()`. `db/migrate.test.ts` / `db/schema-auth.test.ts` instead use `process.cwd()`. This plan follows the `tests/toolchain.test.ts` pattern (§2.7) since it does not depend on the invocation directory.
- Serial-safety: per `docs/prd/breakdown-plan.md` line 54, `fixtures/**` is EVL-01's exclusive file-scope; no other ticket has started work in this path (confirmed: `fixtures/` doesn't exist). `vitest.config.ts` is a shared config file outside the ticket's literally declared write-owns list, but no other in-flight ticket branch touches it (all prior tickets through FND-10 are already merged; their own edits to this file are already in `main`).

## 1. Scope

**In scope** (per ticket Deliverables 1–6, File-scope, and Test plan):

- 10 new JD fixture files under `fixtures/jds/`: 5 AI/ML Engineer (`ai-ml-engineer-01.md`…`-05.md`), 3 Senior SWE (`senior-swe-01.md`…`-03.md`), 2 adversarial (`adversarial-thin.md`, `adversarial-recruiter-fluff.md`).
- 3 new resume fixture files under `fixtures/resumes/`: `synthetic-junior.md`, `synthetic-mid.md`, `synthetic-senior.md` — all fully agent-authored synthetic content, zero real person's data.
- 1 new `fixtures/manifest.json` indexing all 13 files by category/label/seniority (Deliverable 6's exact shape).
- 1 new `fixtures/manifest.test.ts` (named explicitly in the ticket's own Test plan section) asserting the manifest's counts, file-existence, adversarial-thin word count, and empty-metrics representation — the concrete machine form of the acceptance checklist.
- 1 minimal, precedented widening of `vitest.config.ts`'s `test.include` array so the new test file is actually discovered (§0, §2.7) — necessary for acceptance item 5 to mean anything; not itself content authoring.

**Explicitly out of scope** (per ticket Non-goals — do not implement, even opportunistically):

- PRD 附录A's "seed library（9 个项目）" and a real consented resume — tracked as `02-evaluation/README.md` open question #1, owned by Horace. This ticket's 3 resumes are an interim, fully-synthetic stand-in only.
- Any resume/JD "golden" pairing or pre-computed expected `Ledger`/output fixtures — EVL-02's Q1/Q2/Q3 assertions run against rules, not golden comparisons.
- The eval harness itself (`eval/**`, `scripts/eval.mjs`) — EVL-02.
- Any `lib/**` or `app/**` code, and no touch to `eval/**`/`scripts/eval.mjs` per the ticket's explicit File-scope exclusion.
- No `fixtures/README.md` or other documentation file beyond what's listed above — not requested by the ticket; adding it would be unrequested scope.

## 2. Change list

### 2.1 JD fixtures — `fixtures/jds/ai-ml-engineer-01.md` … `-05.md` (5 new files)

Content authoring is the Builder's job ("no design decision beyond writing realistic text" — ticket header). This plan fixes the **structure and constraints** each file must satisfy, not the prose itself:

- English only (PRD §5.8, §4 — target persona is the English-market job seeker).
- **Fictional company names throughout** (e.g. invented names like "Northlake AI", "Fenwick Analytics" — not real companies). Rationale: the ticket's own Deliverable 1 asks for "realistic ... JDs", agent-authored — not literally scraped real postings (scraping/reproducing a real company's real posting verbatim would raise copyright/ToS/misattribution concerns the ticket never asks the Builder to navigate). This reconciles PRD §6's shorthand "10 份真实 JD" (10 real JDs) with the ticket Deliverable's actual, concrete, buildable instruction — flagged explicitly in §5 Open question 2 for the Reviewer, since it is a real (if low-stakes) interpretive call.
- Varied seniority across the 5 files, junior through staff (Deliverable 1's literal wording): suggested spread — `01` junior, `02` mid, `03` senior, `04` staff, `05` senior (different domain, e.g. LLM/generative-AI applications vs. `03`'s MLOps/infra focus, so seniority isn't the only axis of variation).
- Varied domains within AI/ML (NLP, computer vision, MLOps/infra, applied research, LLM applications) so the corpus isn't 5 near-duplicates.
- Each file must contain enough requirement-bearing text to exercise all four of READ's requirement categories (`technical`, `experience`, `domain`, `logistics` — `lib/schemas/pipeline.ts`'s `RequirementCategory` enum, confirmed by direct read): concrete technical skills/stack, a years-of-experience figure, domain-specific knowledge, and at least one logistics fact (visa sponsorship stance, location/remote policy, or similar).
- Target length band: **400–700 words** each — this is the "non-adversarial" side of the mechanical word-count proxy `fixtures/manifest.test.ts` asserts an average over (§2.6); if any individual file runs noticeably outside this band, keep the 8-file average of {5 ai-ml + 3 senior-swe} comfortably above 400 words, since that average is a hard test assertion.
- Suggested (not mandated) section shape for readability/consistency, matching common real-world JD structure: `# <Role Title> — <Fictional Company>`, `## About the role`, `## What you'll do`, `## Requirements`, `## Nice to have`, `## Logistics`.

### 2.2 JD fixtures — `fixtures/jds/senior-swe-01.md` … `-03.md` (3 new files)

Same constraints as §2.1 (English, fictional companies, 400–700 words, all four requirement categories represented), varied domains per Deliverable 2's literal wording: `01` backend/distributed-systems, `02` infrastructure/platform (Kubernetes/cloud), `03` full-stack (product company).

### 2.3 `fixtures/jds/adversarial-thin.md` (1 new file)

- A handful of sentences only — sparse requirements, no structured sections needed.
- **Hard constraint, machine-checked**: under **150 words total** (`fixtures/manifest.test.ts` §2.6 asserts this as a strict `<` bound, not `<=`).
- Must still be a valid, parseable JD-shaped text (a role title and at least one or two genuine requirements) — the point (per ticket Background) is stress-testing READ's ability to produce a valid-but-short `JdExtract` without inventing content that isn't there, not testing READ against empty/garbage input.

### 2.4 `fixtures/jds/adversarial-recruiter-fluff.md` (1 new file)

- Long, buzzword-heavy, corporate-filler-padded (e.g. "rockstar", "fast-paced dynamic environment", "wear many hats", "work hard play hard", "synergy") — per ticket Background, exists to stress READ's `requirements.length <= 11` cap and CROSS's binding quality against noise.
- Must still contain a handful of **genuine, extractable, concrete requirements** buried within the fluff (not zero) — an entirely content-free JD would not actually exercise the cap/dilution scenario the ticket describes; it would just be another thin JD.
- No word-count assertion is made on this file by this ticket's own test (only `adversarial-thin.md`'s shortness is machine-checked, per the acceptance checklist) — but per Deliverable 4's intent, author it noticeably longer than the 8 clean JDs (target: 900+ words) so it has a real chance of stressing the requirement cap once `04-fit`/FIT-01/FIT-02 actually run against it. If it turns out not to stress the cap once those tickets run, the ticket's own Feedback obligation #2 requires revising this fixture (not adjusting EVL-02's threshold to compensate) — that revision is out of this ticket's scope to pre-empt, only to set up honestly.

### 2.5 Resume fixtures — `fixtures/resumes/synthetic-junior.md`, `synthetic-mid.md`, `synthetic-senior.md` (3 new files)

- **Zero real person's data** — fictional name, fictional `@example.com`-style email, fictional/generic city, no real employer names claimed as verifiably-true employment history (same fictional-company rationale as §2.1).
- Seniority-appropriate content: junior (0–2 yrs, 2 projects, more personal/bootcamp-flavored), mid (3–5 yrs, 3 projects mixing paid work + a side project), senior (6+ yrs, 3–4 projects with more scope/leadership signal).
- Every project entry uses this **exact, consistent sub-structure** (so both the human reader and this ticket's own lightweight text-pattern test can rely on it):

  ```
  #### <Project Name>
  - Stack: <comma-separated technologies>
  - Summary: <2–3 sentence technical substance — architecture decisions / tradeoffs, per PRD §5.6's "2–3 句技术实质：架构决策、tradeoff，不是职责描述" — not a duties list>
  - Metrics: <comma-separated real-looking numbers, e.g. "40% latency reduction, 3x throughput increase">
  ```

  and, for a project with no quantifiable output:

  ```
  #### <Project Name>
  - Stack: <comma-separated technologies>
  - Summary: <2–3 sentence technical substance>
  - Metrics: none reported
  ```

- **Design decision (superset-safe, documented here rather than left implicit):** the ticket's Deliverable 5 text reads "each [resume] with ... at least one project with an intentionally empty/no-metrics section", while the acceptance checklist's machine item is the weaker "**at least one** resume fixture contains a project entry with an empty metrics list representation." This plan resolves the tension by requiring **all three** resumes to include at least one `Metrics: none reported` project — this strictly satisfies both readings (the stronger per-resume Deliverable wording and the weaker per-corpus checklist wording), is free (no extra cost, purely a content-authoring choice), and gives `03-library`/LIB-03's empty-metrics UI real fixture coverage across every seniority level rather than just one. Flagged in §5 Open question 3 as a plan-level interpretation, not a ticket-mandated requirement — low-risk either way.
- The literal marker string `Metrics: none reported` (case-insensitive match in the test, §2.6) is this plan's own convention, not dictated by the ticket — flagged in §4/§5 as easily changed if the Reviewer prefers different wording; it is a fixture/testing-only convention, not a contract any other ticket's production code reads via exact string match (LIB-01's PARSE stage is an LLM call over the raw prose, not a regex against this literal string).

### 2.6 `fixtures/manifest.json` (1 new file)

Deliverable 6's exact shape: `{ jds: [{ file, category: 'ai-ml'|'senior-swe'|'adversarial', label }], resumes: [{ file, seniority: 'junior'|'mid'|'senior' }] }`.

**Design decision on the `file` field's path convention (flagged explicitly — this is genuinely consumed by EVL-02, not yet built):** this plan uses **repo-root-relative** path strings (e.g. `"fixtures/jds/ai-ml-engineer-01.md"`), matching how the ticket itself refers to every file throughout (Deliverables 1–5 all write full `fixtures/...` paths, never fixtures-relative shorthand). `fixtures/manifest.test.ts` (§2.7) and EVL-02's future `eval/fixtures.ts` loader should both resolve these via `path.join(repoRoot, entry.file)`. See §4/§5 for the cheap-reversibility note if EVL-02's Builder prefers fixtures-relative paths instead.

```json
{
  "jds": [
    { "file": "fixtures/jds/ai-ml-engineer-01.md", "category": "ai-ml", "label": "AI/ML Engineer — Junior, NLP-focused startup" },
    { "file": "fixtures/jds/ai-ml-engineer-02.md", "category": "ai-ml", "label": "ML Engineer — Mid, computer vision" },
    { "file": "fixtures/jds/ai-ml-engineer-03.md", "category": "ai-ml", "label": "Senior ML Engineer — MLOps/infra" },
    { "file": "fixtures/jds/ai-ml-engineer-04.md", "category": "ai-ml", "label": "Staff ML Engineer — applied research" },
    { "file": "fixtures/jds/ai-ml-engineer-05.md", "category": "ai-ml", "label": "Senior AI Engineer — LLM applications" },
    { "file": "fixtures/jds/senior-swe-01.md", "category": "senior-swe", "label": "Senior Backend Engineer — distributed systems" },
    { "file": "fixtures/jds/senior-swe-02.md", "category": "senior-swe", "label": "Senior Infrastructure/Platform Engineer" },
    { "file": "fixtures/jds/senior-swe-03.md", "category": "senior-swe", "label": "Senior Full-Stack Engineer — product company" },
    { "file": "fixtures/jds/adversarial-thin.md", "category": "adversarial", "label": "Adversarial — extremely thin JD" },
    { "file": "fixtures/jds/adversarial-recruiter-fluff.md", "category": "adversarial", "label": "Adversarial — recruiter-padded, buzzword-heavy JD" }
  ],
  "resumes": [
    { "file": "fixtures/resumes/synthetic-junior.md", "seniority": "junior" },
    { "file": "fixtures/resumes/synthetic-mid.md", "seniority": "mid" },
    { "file": "fixtures/resumes/synthetic-senior.md", "seniority": "senior" }
  ]
}
```

`label` text above is illustrative — the Builder should adjust wording to match whatever specific angle each JD actually took (§2.1/§2.2), but the `file`/`category`/`seniority` values are fixed by this plan and must match exactly (the test in §2.7 counts by these exact string literals).

### 2.7 `fixtures/manifest.test.ts` (1 new file)

```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Repo root, resolved from fixtures/manifest.test.ts (one level down) — same
// pattern as tests/toolchain.test.ts / tests/deploy-vercel.test.ts, independent
// of process.cwd() so this test is safe to run from any invocation directory.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

type ManifestEntry = { file: string; category?: string; seniority?: string; label?: string };
type Manifest = { jds: ManifestEntry[]; resumes: ManifestEntry[] };

const manifest: Manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'fixtures', 'manifest.json'), 'utf8'),
);

const readFixture = (relFile: string) => readFileSync(path.join(repoRoot, relFile), 'utf8');

// Mechanical word-count proxy — does not strip markdown syntax (#, -, **); the
// ~2.5x gap between the adversarial-thin threshold (150) and the non-adversarial
// average threshold (400) absorbs that noise. Matches the ticket acceptance
// checklist's own framing ("a mechanical proxy for 极薄").
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

describe('fixtures/manifest.json', () => {
  it('lists exactly 10 JD entries: 5 ai-ml, 3 senior-swe, 2 adversarial', () => {
    expect(manifest.jds).toHaveLength(10);
    const byCategory = (cat: string) => manifest.jds.filter((j) => j.category === cat).length;
    expect(byCategory('ai-ml')).toBe(5);
    expect(byCategory('senior-swe')).toBe(3);
    expect(byCategory('adversarial')).toBe(2);
  });

  it('lists exactly 3 resume entries', () => {
    expect(manifest.resumes).toHaveLength(3);
  });

  it('every file referenced in the manifest exists on disk', () => {
    for (const entry of [...manifest.jds, ...manifest.resumes]) {
      expect(existsSync(path.join(repoRoot, entry.file)), `missing file: ${entry.file}`).toBe(true);
    }
  });

  it('adversarial-thin.md has a substantially shorter word count than the average of the 8 non-adversarial JDs', () => {
    const thinEntry = manifest.jds.find((j) => j.file.endsWith('adversarial-thin.md'));
    expect(thinEntry, 'adversarial-thin.md must be listed in manifest.json').toBeDefined();
    const thinWords = wordCount(readFixture(thinEntry!.file));

    const nonAdversarial = manifest.jds.filter((j) => j.category !== 'adversarial');
    expect(nonAdversarial).toHaveLength(8);
    const avgWords =
      nonAdversarial.reduce((sum, j) => sum + wordCount(readFixture(j.file)), 0) /
      nonAdversarial.length;

    expect(thinWords).toBeLessThan(150);
    expect(avgWords).toBeGreaterThan(400);
    // "substantially shorter than the average" — relative check, not just two
    // independent absolute thresholds.
    expect(thinWords).toBeLessThan(avgWords * 0.5);
  });

  it('at least one resume fixture contains a project entry with an empty metrics representation', () => {
    const hasEmptyMetrics = manifest.resumes.some((r) =>
      /Metrics:\s*none reported/i.test(readFixture(r.file)),
    );
    expect(hasEmptyMetrics).toBe(true);
  });
});
```

This directly covers acceptance checklist items 1–4 (manifest counts, file existence, adversarial-thin word count, empty-metrics representation).

### 2.8 `vitest.config.ts` (edit — 1-line addition to `test.include`)

Add `'fixtures/**/*.test.ts'` to the `include` array (§0 explains why this is required, not optional):

```ts
    include: [
      'tests/**/*.test.ts',
      'lib/**/*.test.ts',
      'db/**/*.test.ts',
      '*.test.ts',
      'app/**/*.test.{ts,tsx}',
      // `fixtures/**/*.test.ts` added by EVL-01 so the new manifest test
      // (fixtures/manifest.test.ts) is discovered — none of the prior globs
      // reach fixtures/**. Same false-green failure mode FND-02/05/06/08/09
      // each fixed for their own new test locations.
      'fixtures/**/*.test.ts',
    ],
```

No other line in `vitest.config.ts` changes.

## 3. Test plan

Maps directly to the ticket's acceptance checklist:

1. **`pnpm test` exits 0**, and its output lists `fixtures/manifest.test.ts` alongside every pre-existing suite (`tests/**`, `lib/**`, `db/**`, root `*.test.ts`, `app/**`) — confirms §2.8's include-widening actually took effect (don't just check the exit code; check the file list appears, per this repo's established "don't let a glob miss create a false green" discipline).
2. **Acceptance item 1** (manifest lists exactly 10 JD entries split 5/3/2, exactly 3 resume entries): §2.7's first two `it` blocks.
3. **Acceptance item 2** (every manifest-referenced file exists on disk): §2.7's third `it` block, using `existsSync` per referenced file.
4. **Acceptance item 3** (`adversarial-thin.md` substantially shorter than the average of the 8 non-adversarial JDs, mechanical word-count proxy): §2.7's fourth `it` block — `thinWords < 150`, `avgWords > 400`, `thinWords < avgWords * 0.5`.
5. **Acceptance item 4** (at least one resume fixture has an empty-metrics project entry, text-pattern check): §2.7's fifth `it` block, matching the `Metrics: none reported` marker. Per §2.5's design decision, this should in practice pass for all 3 resumes, not just one — the test only asserts the checklist's literal "at least one" bar, but the fixture authoring target is all three.
6. **No file outside File-scope + this plan's one documented deviation was touched**: `git diff --stat 64f8f41..HEAD` (base commit confirmed in §0) should list exactly: 13 new files under `fixtures/jds/**` + `fixtures/resumes/**`, `fixtures/manifest.json`, `fixtures/manifest.test.ts` (16 new files total), plus a 1-line addition to `vitest.config.ts`. Anything else in the diff (in particular `eval/**`, `scripts/eval.mjs`, any `lib/**` or `app/**` path, `package.json`) is a File-scope violation and must be reverted before merge.
7. All of the above are reproducible fully offline — no DB, no Anthropic API, no network. This ticket's own test is pure filesystem + JSON assertions, matching the ticket's own Test plan framing exactly.

## 4. Risks & edge cases

- **Concurrency: N/A.** Every artifact in this ticket is static content (13 markdown files, one JSON index) plus one synchronous, read-only filesystem test. No shared mutable state, no async race, no DB, no network call anywhere in this ticket's scope. Explicitly called out (per this repo's established plan convention) rather than silently omitted.
- **Security-sensitive path: privacy of the synthetic resumes.** The ticket's Non-goals is explicit and load-bearing: "ALL agent-authored synthetic content, containing no real person's data." The Reviewer should specifically verify:
  - No real person's name, email, phone number, physical address, or employer-verifiable work history appears in any of the 3 resume fixtures — only obviously fictional placeholders (`@example.com`-style emails, invented names, generic/fictional city references).
  - No real, currently-operating company is named as an employer in the resumes (this is the actual privacy/misattribution risk — a fictional person "having worked at" a real, identifiable company is a more subtle harm than an obviously-fake email address).
  - The same fictional-company discipline is applied to the JD fixtures (§2.1/§2.2) for a parallel but distinct reason: avoiding any implication that a real company's actual posting was scraped or misrepresented.
- **Same-agent-authors-both-content-and-test fragility**: because the Builder writes both the adversarial-thin JD's prose and the test asserting its word count (§2.7), there is an inherent risk of the test being informally "tuned" to whatever was written rather than the fixture actually being held to the ticket's own stated bar. This plan mitigates it by pinning the ticket's own literal example numbers (`< 150` / `> 400`) as **hard thresholds in the test code itself** (§2.7), not left as Builder-chosen constants — the Builder must make the actual fixture content satisfy these pre-specified numbers, not the reverse.
- **`Metrics: none reported` marker convention (§2.5) is this plan's own invention, not ticket-dictated** — flagged so a Reviewer doesn't mistake it for a hidden requirement elsewhere in the codebase. It is a fixture/test-only convention: no other ticket's production code reads this exact string (LIB-01's PARSE stage is an LLM semantic parse over the raw prose, not a regex match). One-line change in both the fixture prose and §2.7's regex if the Reviewer prefers different wording — no cascading impact.
- **`fixtures/manifest.json`'s `file` path convention (repo-root-relative, §2.6) is a genuine decision consumed by a downstream ticket that does not exist yet (EVL-02's `eval/fixtures.ts`)**. If EVL-02's Builder finds a fixtures-relative convention (e.g. `"jds/ai-ml-engineer-01.md"`) more natural for its loader, that is a one-line change to every `file` value in this manifest plus one join-path line in EVL-02's loader — no data loss, no migration, cheap to reverse. Flagged explicitly rather than left implicit, since EVL-02 is this ticket's direct, named downstream consumer (`blocks: [EVL-02, LIB-01]`).
- **Windows/cross-platform**: `vitest.config.ts`'s new `'fixtures/**/*.test.ts'` glob and `fixtures/manifest.json`'s forward-slash `file` values both need to resolve correctly on the Windows dev environment this repo is built on. `path.join(repoRoot, entry.file)` (§2.7) handles a forward-slash-delimited string correctly on `win32` (Node's `path.join` accepts either separator as input on Windows and normalizes output) — no special-casing needed, but flagged explicitly per this repo's established convention (FND-05/FND-06/FND-07 plans each did the same for their own files) since this is the first ticket to embed relative paths inside a checked-in JSON data file rather than only inside TypeScript source.
- **Recruiter-fluff fixture (`adversarial-recruiter-fluff.md`) has no machine assertion in this ticket** — only its existence and category tagging are checked (§2.7's item 1/3); whether it actually stresses `requirements.length <= 11` is unknowable until `04-fit`/FIT-01/FIT-02 run against it, per the ticket's own Feedback obligation #2. This plan does not attempt to pre-validate that property (it can't — no READ implementation exists yet in this ticket's dependency order), and explicitly defers it rather than inventing a proxy test for something this ticket cannot actually verify.

## 5. Open questions

| # | Question | Who decides |
|---|---|---|
| 1 | `fixtures/manifest.json`'s `file` field path convention: this plan chose repo-root-relative strings (`"fixtures/jds/....md"`) over fixtures-relative shorthand. Confirmed workable for this ticket's own test; genuinely binding on EVL-02's future loader. | EVL-02's Builder, at build time — cheap to change (§4) if a different convention is preferred; not escalation-worthy. |
| 2 | Whether "realistic, agent-authored, fictional-company JDs" (this plan's approach, §2.1) adequately satisfies PRD §6's literal "10 份真实 JD" (10 *real* JDs) phrasing, versus PRD intending literally-sourced real postings. This plan follows the ticket's own concrete Deliverable wording ("realistic ... JDs", explicitly agent-authored per the ticket header) over PRD's shorter prose gloss, since the ticket is the executable spec and scraping/reproducing real postings raises unaddressed copyright/ToS concerns. | Reviewer, at review time — if disputed, escalate to Horace (product) per the ticket's own precedent for PRD-vs-reality tensions (e.g. open question #1's resume handling); not blocking, since the ticket's own Deliverable text already resolves it for this ticket's purposes. |
| 3 | Whether requiring an empty-metrics project in **all three** resumes (§2.5), rather than strictly the checklist's literal "at least one resume", is the right reading of Deliverable 5's "each ... at least one project with an intentionally empty/no-metrics section." This plan treats it as a safe superset (satisfies both readings, free to do, better fixture coverage for LIB-03) rather than an open risk. | Not actually open — restated here only so the Reviewer doesn't mistake the stronger implementation for scope creep; it strictly satisfies the literal checklist bar as a subset of what's delivered. |
| 4 | The real consented resume (PRD's "1 份真实授权") and PRD 附录A's seed library remain unresolved, per `02-evaluation/README.md`'s open question #1 — **not re-opened by this ticket**, restated only for cold-start completeness; this ticket ships the documented 3-synthetic-resume interim stand-in per its own Non-goals, and the ticket's own Feedback obligation #1 already fixes the swap-in procedure once Horace supplies the real asset. | Horace (product) — already tracked, no new decision needed from this plan. |

## 6. ADR-candidate flag

**Not proposing a new ADR.** The ticket states this explicitly up front: "No ADR — the decision is already made in PRD §6 (fixtures spec); this is build ticket 1 of 2 against the `02-evaluation` module." This plan's own contributions — the `fixtures/manifest.json` path convention (§2.6), the `Metrics: none reported` marker (§2.5), and the fictional-company-names authoring choice (§2.1) — are all cheap-to-reverse tuning decisions with exactly one or zero downstream consumers each (EVL-02's not-yet-built loader, and this ticket's own test, respectively), not hard architectural lock-in comparable to e.g. FND-03's `Ledger.bindings`/`gaps` disjoint-union shape. No ADR is proposed by this plan.
