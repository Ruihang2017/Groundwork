import type { Intel } from '@/lib/schemas/pipeline';

// PRP-04 Deliverable 1 (plan §2.4 / D9) — the "research fail 标红" banner (PRD §5.7:
// "research fail 标红但简报照常渲染").
//
// SELF-GUARDING: renders ONLY when `intel === null` (RESEARCH failed / degraded, PRD §2 P3),
// and returns `null` otherwise. BriefView renders this ALONGSIDE the rest of the brief,
// unconditionally, so the banner appears WITH the questions/askThem/positioning, "never in
// place of it" (Deliverable 1 / acceptance item 3). The intel card is its complement — it
// renders only when `intel !== null`.
//
// The copy is exported as a constant so its test cannot drift from it (mirrors
// lock-screen.tsx's PREP_UNLOCK_COPY). Rendered as TEXT — no HTML injection.

const DANGER = '#b00020';

/** PRD §5.7 "research fail 标红". Exported so the copy and its test cannot drift. */
export const RESEARCH_FAIL_COPY =
  'Company research was not available for this job, so the intel section is empty. The rest of your interview brief below is unaffected.';

export default function ResearchFailBanner({ intel }: { intel: Intel | null }) {
  // Complement of intel-card.tsx: nothing to flag when RESEARCH succeeded.
  if (intel !== null) return null;

  return (
    <section
      role="alert"
      style={{
        border: `1px solid ${DANGER}`,
        borderRadius: '4px',
        color: DANGER,
        margin: '0 0 1.5rem',
        padding: '1rem',
      }}
    >
      <p style={{ margin: 0 }}>{RESEARCH_FAIL_COPY}</p>
    </section>
  );
}
