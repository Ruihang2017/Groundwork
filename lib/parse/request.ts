import { PRIMARY_MODEL } from '@/lib/config/models';
import {
  buildParseUserText,
  buildRepairUserText,
  PARSE_SYSTEM_PROMPT,
} from '@/lib/parse/prompt';

// LIB-01 — the Anthropic Messages-API WIRE SHAPE for the PARSE stage.
//
// Why this file exists separately from pdf.ts / prompt.ts (plan §2.1): all three
// input paths (PDF, DOCX, pasted text) need a request object but only one is a
// PDF, so `buildTextParseRequest` in `pdf.ts` would be misnamed; and putting it
// in `prompt.ts` would make "the prompt file" also own the wire shape. This file
// owns the wire shape; `prompt.ts` owns words.
//
// No SDK, by PRD §8.1 ("Zod 边界 + 裸 fetch 足够"). These are plain object types
// describing exactly the JSON body the route POSTs with `fetch`.

// Enough for a full resume transcription plus a complete Library JSON. Not
// PRD-specified — a Builder-adjustable constant. If a reply hits it, the route
// sees `stop_reason: 'max_tokens'` and treats it as a repairable failure rather
// than silently returning truncated content.
export const PARSE_MAX_TOKENS = 8192;

export type AnthropicTextBlock = { type: 'text'; text: string };

export type AnthropicDocumentBlock = {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
};

export type AnthropicMessageRequest = {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{
    role: 'user';
    content: Array<AnthropicTextBlock | AnthropicDocumentBlock>;
  }>;
};

/**
 * The pasted-plain-text path, and the DOCX path after mammoth has extracted text
 * (DOCX text is sent as TEXT, never re-wrapped as a document block).
 */
export function buildTextParseRequest(sourceText: string): AnthropicMessageRequest {
  return {
    // FND-06's pin — never a hardcoded model string (PRD §8.1 "模型 pin 在 config").
    model: PRIMARY_MODEL,
    max_tokens: PARSE_MAX_TOKENS,
    system: PARSE_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: [{ type: 'text', text: buildParseUserText(sourceText) }] },
    ],
  };
}

/**
 * The single JSON-repair retry. Deliberately does NOT re-send the document/text:
 * repair is about malformed JSON, and re-sending a base64 PDF would double the
 * paid input tokens for zero benefit (plan §2.5).
 */
export function buildRepairRequest(
  previousOutput: string,
  errorSummary: string,
): AnthropicMessageRequest {
  return {
    model: PRIMARY_MODEL,
    max_tokens: PARSE_MAX_TOKENS,
    system: PARSE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: buildRepairUserText(previousOutput, errorSummary) }],
      },
    ],
  };
}
