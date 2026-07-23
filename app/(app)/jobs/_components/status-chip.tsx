import type { JobStatus } from '@/lib/schemas/persisted';

// FIT-03 Deliverable 1 — PRD §5.7's Jobs 列表 row: "每个 job 带状态 chip：screening →
// applied → interviewing → closed".
//
// NO `'use client'` DIRECTIVE, deliberately (plan E13). This component has no hooks
// and touches no browser API, so it renders in both a server and a client tree — and
// it is used from both (the Jobs list page and the job-detail layout are Server
// Components; nothing here needs to be in the client bundle).
//
// A `Record<JobStatus, string>` rather than a switch or a `.toUpperCase()`: if FND-04's
// enum ever grows a fifth value, TypeScript fails to compile this file instead of
// silently rendering a raw lowercase token.
//
// THE LABEL IS REAL TEXT, and colour is only ever an addition (same reasoning as plan
// D12 for hard requirements): a chip whose meaning lives in its background colour is
// unreadable for colour-blind users and in monochrome. No `aria-label` duplicating the
// visible text — it would add nothing and would complicate every query.
//
// READ-ONLY. This ticket ships no status-transition control: TLR-02 owns "mark as
// applied" and PRP-03 owns "I got an interview" (04-fit/README's decision).

const LABELS: Record<JobStatus, string> = {
  screening: 'Screening',
  applied: 'Applied',
  interviewing: 'Interviewing',
  closed: 'Closed',
};

const COLOURS: Record<JobStatus, string> = {
  screening: '#3a3a3a',
  applied: '#1c4f9c',
  interviewing: '#146c2e',
  closed: '#6b6b6b',
};

export default function StatusChip({ status }: { status: JobStatus }) {
  return (
    <span
      style={{
        border: `1px solid ${COLOURS[status]}`,
        borderRadius: '999px',
        color: COLOURS[status],
        fontSize: '0.8rem',
        padding: '0.1rem 0.5rem',
        whiteSpace: 'nowrap',
      }}
    >
      {LABELS[status]}
    </span>
  );
}
