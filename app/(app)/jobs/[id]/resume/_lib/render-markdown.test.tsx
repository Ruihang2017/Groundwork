// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderMarkdown } from '@/app/(app)/jobs/[id]/resume/_lib/render-markdown';
import { MARKDOWN_FIXTURE } from '@/app/(app)/jobs/[id]/resume/_fixtures/tailored-fixtures';

// TLR-02 plan §3.2 / D3 correctness + the R1 security check. The renderer is the reason the
// [human] §13 Q2 print-fidelity check can be meaningful (raw markdown is not "可直接投递").

afterEach(cleanup);

function renderMd(md: string) {
  return render(<div data-testid="md">{renderMarkdown(md)}</div>);
}

describe('renderMarkdown — block structure', () => {
  it('[machine] renders # / ## as h1 / h2', () => {
    const { container } = renderMd(MARKDOWN_FIXTURE);
    expect(container.querySelector('h1')?.textContent).toBe('Heading One');
    expect(container.querySelector('h2')?.textContent).toBe('Heading Two');
  });

  it('[machine] renders all six heading levels by # count', () => {
    const { container } = renderMd('# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f');
    expect(container.querySelector('h3')?.textContent).toBe('c');
    expect(container.querySelector('h6')?.textContent).toBe('f');
  });

  it('[machine] renders an unordered list as ul > li', () => {
    const { container } = renderMd(MARKDOWN_FIXTURE);
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    const items = ul!.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('first bullet');
  });

  it('[machine] renders an ordered list as ol > li (marker stripped)', () => {
    const { container } = renderMd(MARKDOWN_FIXTURE);
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    const items = ol!.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('first step');
  });

  it('[machine] renders a horizontal rule from a --- line', () => {
    const { container } = renderMd('above\n\n---\n\nbelow');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('[machine] preserves an internal hard line break in a paragraph as <br/>', () => {
    const { container } = renderMd(MARKDOWN_FIXTURE);
    // The address paragraph has two lines joined by a hard break.
    const paragraphs = [...container.querySelectorAll('p')];
    const address = paragraphs.find((p) => p.textContent?.includes('123 Main Street'));
    expect(address).toBeTruthy();
    expect(address!.querySelector('br')).not.toBeNull();
  });
});

describe('renderMarkdown — inline formatting', () => {
  it('[machine] renders **bold** as <strong>, *italic*/_italic_ as <em>, `code` as <code>', () => {
    const { container } = renderMd('This is **bold** and *italic* and _also_ and `code`.');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    const ems = [...container.querySelectorAll('em')].map((e) => e.textContent);
    expect(ems).toContain('italic');
    expect(ems).toContain('also');
    expect(container.querySelector('code')?.textContent).toBe('code');
  });
});

describe('renderMarkdown — SECURITY (plan R1)', () => {
  it('[machine] renders an http(s) link as an anchor with that href', () => {
    const { container } = renderMd('[safe link](https://example.com)');
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.textContent).toBe('safe link');
  });

  it('[machine] renders a javascript: link as PLAIN TEXT — no anchor at all', () => {
    const { container } = renderMd('[danger link](javascript:alert(1))');
    // No anchor is produced for a disallowed scheme.
    expect(container.querySelector('a')).toBeNull();
    // …but the label survives as text.
    expect(container.textContent).toContain('danger link');
  });

  it('[machine] rejects a data: URL the same way', () => {
    const { container } = renderMd('[x](data:text/html,<script>alert(1)</script>)');
    expect(container.querySelector('a')).toBeNull();
  });

  it('[machine] never turns a <script>-looking token into a real element (React escaping)', () => {
    const { container } = renderMd(MARKDOWN_FIXTURE);
    // The fixture contains a literal <script>…</script>; it must be text, not an element.
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('[machine] the fixture as a whole produces exactly one safe anchor and no javascript anchor', () => {
    const { container } = renderMd(MARKDOWN_FIXTURE);
    const anchors = container.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });
});
