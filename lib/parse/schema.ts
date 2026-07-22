import { z } from 'zod';

import { Library } from '@/lib/schemas/entities';

// LIB-01 — the PARSE route's response contract, and the Zod boundary every
// model reply must clear before ANY of it reaches the client (PRD §5.5).
//
// Location per docs/prd/breakdown-plan.md §3: module-local Zod types live in the
// module's own directory (`lib/parse/schema.ts` is named verbatim there), never
// written back into `lib/schemas/**` (FND-02/03's file-scope).
//
// `z.string()` (not `.min(1)`) is the ticket's literal shape. An EMPTY
// `projects` array is a legal success, not a failure: PRD §3 C1 makes manual
// entry a supplement to parsing and LIB-03 ships an "add project" affordance, so
// failing the request would strand a user whose resume is prose-only. Do not add
// a `projects.length > 0` gate here — the `[fixture]` acceptance test asserts
// non-empty projects for the three fixtures, which is a statement about parse
// QUALITY on real input, not a route-level invariant.
export const ParseResult = z.object({
  resumeMd: z.string(),
  draftLibrary: Library,
});
export type ParseResult = z.infer<typeof ParseResult>;
