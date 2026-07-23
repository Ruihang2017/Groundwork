import { Fragment, type ReactNode } from 'react';

// TLR-02 (plan §3.2 / D3) — a small, in-repo, documented-SUBSET markdown → React
// renderer. No dependency (adding react-markdown would touch package.json and pull a
// remark/micromark tree; heavier than this M ticket needs).
//
// WHY A RENDERER AT ALL: raw markdown printed verbatim (`##`, `**`, `- `) is obviously
// not "可直接投递", which would make PRD §13 Q2's [human] print-fidelity check fail for
// the WRONG reason. A renderer makes that check meaningful. The subset is deliberately
// BOUNDED — anything outside it renders as literal text (that literalness is itself part
// of what the [human] check judges); do NOT chase completeness here (Feedback obligation
// #1). It is reversible: swap to react-markdown, or to the §13 Q2 template engine, later.
//
// SECURITY (plan R1 — the Reviewer's primary check). Everything is rendered as React
// elements/text, so React escapes it and HTML injection is structurally impossible — no
// `dangerouslySetInnerHTML` anywhere. The ONLY attacker-influenced attribute is a link
// `href`: `fullDraftMd` is server-number-filtered by TLR-01 but is still model-derived,
// so it is untrusted. A `[label](url)` becomes an anchor ONLY when `url` starts with
// `http://`, `https://`, or `mailto:` (case-insensitive); otherwise the label renders as
// plain text with no anchor, blocking `javascript:`/`data:` URLs.
//
// Index-based React keys are acceptable: content is static per render and never reordered.

/** Anchor only for these schemes; anything else (javascript:, data:, …) renders as text. */
const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

type InlineRule = {
  regex: RegExp;
  build: (match: RegExpExecArray, key: string) => ReactNode;
};

// Order matters: `**bold**` is tried before `*em*` so a bold run is never mis-split. Each
// regex is NON-global (exec always scans from index 0 of the remaining string).
const INLINE_RULES: InlineRule[] = [
  { regex: /\*\*([^*]+)\*\*/, build: (m, key) => <strong key={key}>{m[1]}</strong> },
  { regex: /\*([^*]+)\*/, build: (m, key) => <em key={key}>{m[1]}</em> },
  { regex: /_([^_]+)_/, build: (m, key) => <em key={key}>{m[1]}</em> },
  { regex: /`([^`]+)`/, build: (m, key) => <code key={key}>{m[1]}</code> },
  {
    regex: /\[([^\]]*)\]\(([^)]*)\)/,
    build: (m, key) => {
      const url = m[2].trim();
      // No anchor for a disallowed scheme — render the label as plain text.
      return SAFE_URL.test(url) ? <a key={key} href={url}>{m[1]}</a> : m[1];
    },
  },
];

/**
 * A single, non-nested inline pass. Repeatedly finds the EARLIEST-matching rule, emits the
 * plain text before it and the rule's element, and continues after the match. Nested
 * emphasis (e.g. bold inside a link) is out of subset and renders literally.
 */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let remaining = text;
  let counter = 0;
  while (remaining.length > 0) {
    let best: { index: number; rule: InlineRule; match: RegExpExecArray } | null = null;
    for (const rule of INLINE_RULES) {
      const match = rule.regex.exec(remaining);
      if (match && (best === null || match.index < best.index)) {
        best = { index: match.index, rule, match };
      }
    }
    if (!best) {
      out.push(remaining);
      break;
    }
    if (best.index > 0) out.push(remaining.slice(0, best.index));
    out.push(best.rule.build(best.match, `${keyBase}-i${counter}`));
    counter += 1;
    remaining = remaining.slice(best.index + best.match[0].length);
  }
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^(?:-{3,}|\*{3,})$/;
const UL_ITEM = /^[-*]\s+/;
const OL_ITEM = /^\d+\.\s+/;

function renderBlock(block: string, key: string): ReactNode {
  const lines = block.split('\n');

  if (lines.length === 1) {
    const heading = HEADING.exec(lines[0]);
    if (heading) {
      const level = heading[1].length;
      // These six are all valid intrinsic elements — a typed union, not `any`.
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag key={key}>{renderInline(heading[2], key)}</Tag>;
    }
    if (HR.test(lines[0].trim())) {
      return <hr key={key} />;
    }
  }

  if (lines.every((line) => UL_ITEM.test(line))) {
    return (
      <ul key={key}>
        {lines.map((line, i) => (
          <li key={`${key}-li${i}`}>{renderInline(line.replace(UL_ITEM, ''), `${key}-li${i}`)}</li>
        ))}
      </ul>
    );
  }

  if (lines.every((line) => OL_ITEM.test(line))) {
    return (
      <ol key={key}>
        {lines.map((line, i) => (
          <li key={`${key}-li${i}`}>{renderInline(line.replace(OL_ITEM, ''), `${key}-li${i}`)}</li>
        ))}
      </ol>
    );
  }

  // Paragraph: internal line breaks preserved as <br/> (resume address/contact lines
  // depend on hard breaks).
  return (
    <p key={key}>
      {lines.map((line, i) => (
        <Fragment key={`${key}-l${i}`}>
          {i > 0 ? <br /> : null}
          {renderInline(line, `${key}-l${i}`)}
        </Fragment>
      ))}
    </p>
  );
}

/** Documented-subset markdown → React elements. Never returns HTML strings. */
export function renderMarkdown(md: string): ReactNode {
  // Split into blocks on blank lines (a newline, optional inline whitespace, newline).
  const blocks = md.replace(/\r\n/g, '\n').split(/\n[ \t]*\n/);
  const rendered: ReactNode[] = [];
  let key = 0;
  for (const raw of blocks) {
    const block = raw.replace(/^\n+|\n+$/g, '');
    if (block.trim() === '') continue;
    rendered.push(renderBlock(block, `b${key}`));
    key += 1;
  }
  return <>{rendered}</>;
}
