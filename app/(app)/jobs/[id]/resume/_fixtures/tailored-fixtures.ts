import type { Library } from '@/lib/schemas/entities';
import type { TailoredResume } from '@/lib/schemas/persisted';

// TLR-02 — TEST-ONLY fixtures (plan §3.16). Mirrors app/(app)/jobs/_fixtures/job-fixtures.ts
// conventions EXACTLY: HAND-WRITTEN LITERALS ONLY — no `node:fs`, no `@/eval` import, no
// `import.meta.url` (all of which throw at import under Vitest's jsdom environment). Only
// TYPE imports of pure schema types; nothing here drags drizzle. No production module
// imports this file, and `_`-prefixed folders are Next.js private (never routed).

const JOB_ID = 'job-1';

/**
 * A library whose project ids match the fixture edits' `projectId`s, so project-name
 * resolution has hits. `ghost-project` is deliberately ABSENT (the third edit references
 * it) to exercise the raw-id fallback (plan R4). Kebab-case ids satisfy Project.id's regex.
 */
export const LIBRARY_FIXTURE: Library = {
  profile: {
    name: 'Ada Lovelace',
    headline: 'Platform engineer',
    contact: { email: 'ada@example.com', links: [] },
  },
  projects: [
    {
      id: 'voice-agent',
      name: 'Voice Agent',
      stage: 'shipped',
      role: 'Tech lead',
      stack: ['Go', 'Kubernetes'],
      summary: 'Real-time voice routing on EKS; chose gRPC streaming over REST for latency.',
      metrics: ['2.1M calls/day', '40-node cluster'],
      tags: ['infra'],
    },
    {
      id: 'billing-migration',
      name: 'Billing Migration',
      stage: 'shipped',
      role: 'Backend engineer',
      stack: ['Postgres', 'Go'],
      summary: 'Migrated a card-billing ledger table by table with dual-writes and no downtime.',
      metrics: ['zero downtime'],
      tags: ['payments'],
    },
  ],
};

/**
 * The full draft. Contains each edit's `original` VERBATIM (so `deriveDraft` has anchors to
 * hit) and exercises the renderer subset: two headings, a bold span, and a bullet list.
 */
const FULL_DRAFT_MD = `# Ada Lovelace

**Platform engineer** focused on payments infrastructure.

## Experience

- Ran a cluster serving many calls.
- Worked on billing.
- Led a small team.`;

/**
 * An alignment covering ALL FOUR statuses (including one `missing_in_library` — the gap
 * that must never gain an accept action), 3 edits referencing library project ids (the
 * third referencing an absent id for the fallback), and the markdown draft above.
 */
export const TAILORED_FIXTURE: TailoredResume = {
  jobId: JOB_ID,
  alignment: [
    { keyword: 'Kubernetes', status: 'present' },
    {
      keyword: 'Terraform',
      status: 'missing_in_resume',
      note: 'You have used it; it is just not on the resume yet.',
    },
    {
      keyword: 'Rust',
      status: 'missing_in_library',
      note: 'Nothing in your library backs this — shown as a gap, not written in.',
    },
    { keyword: 'K8s', status: 'synonym_mismatch', note: 'The JD says K8s; your resume says Kubernetes.' },
  ],
  edits: [
    {
      original: 'Ran a cluster serving many calls.',
      suggested: 'Ran a 40-node EKS cluster serving 2.1M calls/day.',
      rationale: 'Quantify the scale with real numbers from the library.',
      projectId: 'voice-agent',
    },
    {
      original: 'Worked on billing.',
      suggested: 'Migrated a card-billing ledger with zero downtime.',
      rationale: 'Name the concrete outcome.',
      projectId: 'billing-migration',
    },
    {
      original: 'Led a small team.',
      suggested: 'Led a team of five engineers.',
      rationale: 'Be specific about scope.',
      // Deliberately NOT in LIBRARY_FIXTURE — exercises the raw-id fallback (plan R4).
      projectId: 'ghost-project',
    },
  ],
  fullDraftMd: FULL_DRAFT_MD,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};

/**
 * TLR-01's exact 200 body: the persisted TailoredResume at the top level plus the additive
 * `dropped` key, with at least one dropped edit and one dropped number (count = 1 + 1 = 2).
 */
export function tailorResponseFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...TAILORED_FIXTURE,
    dropped: {
      count: 2,
      edits: [
        {
          item: {
            original: 'Handled a huge amount of traffic.',
            suggested: 'Handled 9,000,000,000 requests.',
            rationale: 'Add a number.',
            projectId: 'not-in-library',
          },
          reason: 'projectId not in library',
        },
      ],
      numbers: [{ token: '9000000000', reason: 'not found in the source resume or library metrics' }],
    },
    ...overrides,
  };
}

/**
 * A small markdown doc exercising the whole renderer subset: headings, bold + italic (both
 * `*` and `_`), inline code, unordered + ordered lists, an http link, a `javascript:` link
 * (the security case — must render NO anchor), a `<script>`-looking token (must render as
 * text), and a paragraph with an internal hard line break.
 */
export const MARKDOWN_FIXTURE = `# Heading One

## Heading Two

This is **bold** and this is *italic* and _also italic_ and \`code\`.

- first bullet
- second bullet

1. first step
2. second step

[safe link](https://example.com) and [danger link](javascript:alert(1)).

Contains <script>alert(1)</script> markup that must stay text.

123 Main Street
Springfield, USA`;
