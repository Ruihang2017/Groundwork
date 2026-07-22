import mammoth from 'mammoth';

// LIB-01 Deliverable 2 — the DOCX path.
//
// PRD §8.1: "DOCX 经 mammoth 提取文本". The extracted text is then sent to the
// model as PLAIN TEXT via buildTextParseRequest — it is NOT re-wrapped as a
// document block.
//
// PRIVACY (PRD §8.1 "原始文件解析后即弃、不落盘"): mammoth is called with
// `{ buffer }`, never `{ path }` — the bytes never touch the filesystem. Do not
// switch to the path form; the static scan in app/api/parse/route.test.ts guards
// the fs/blob surface, but `{ path }` would additionally require a temp file to
// exist, which this route must never create.
//
// KNOWN QUALITY RISK (ticket Feedback obligation #2, plan §4 R4):
// `extractRawText` drops structure — headings and list markers vanish, each
// paragraph becoming its own line. If that degrades the model's ability to
// separate projects from other resume sections, metrics attribution degrades
// with it, which is a P2 guardrail risk rather than a cosmetic one. Do NOT
// silently switch to `mammoth.convertToMarkdown()` (which preserves headings and
// lists but is documented by mammoth as early-stage): the ticket requires
// escalating to Horace — de-scope DOCX to "convert to PDF first" guidance in
// LIB-03? — instead of papering over it here.

/**
 * Extracts plain text from a `.docx` buffer.
 *
 * Deliberately does NOT catch: a malformed/non-DOCX buffer makes mammoth reject,
 * and the route converts every failure into its single 422 `parse_failed`
 * contract in one place. Swallowing the rejection here would return an empty
 * string and send an empty resume to a paid model call.
 */
export async function extractDocxText(fileBuffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: fileBuffer });
  return value;
}
