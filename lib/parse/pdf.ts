import { PRIMARY_MODEL } from '@/lib/config/models';
import { PARSE_PDF_USER_INSTRUCTION, PARSE_SYSTEM_PROMPT } from '@/lib/parse/prompt';
import { PARSE_MAX_TOKENS, type AnthropicMessageRequest } from '@/lib/parse/request';

// LIB-01 Deliverable 1 — the PDF path.
//
// PRD §8.1: "PDF 走 Anthropic 原生 document input（对版式鲁棒，免解析库）" — no
// pdf-parse / pdfjs / OCR dependency; the raw bytes go to the model as a native
// document content block.
//
// PRIVACY (PRD §8.1 "原始文件解析后即弃、不落盘"): the buffer is base64-encoded
// into the request body and never written anywhere. This module performs no
// filesystem or blob-storage access of any kind — mechanically enforced by the
// static scan in app/api/parse/route.test.ts, and legally load-bearing because
// app/(legal)/privacy/page.tsx already publishes this promise to users.

/**
 * Builds the Messages-API request for a PDF resume using Anthropic's native
 * base64 document input.
 *
 * The document block comes BEFORE the instruction text — Anthropic's documented
 * ordering for document inputs.
 */
export function buildPdfParseRequest(fileBuffer: Buffer): AnthropicMessageRequest {
  return {
    model: PRIMARY_MODEL,
    max_tokens: PARSE_MAX_TOKENS,
    system: PARSE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: fileBuffer.toString('base64'),
            },
          },
          { type: 'text', text: PARSE_PDF_USER_INSTRUCTION },
        ],
      },
    ],
  };
}
