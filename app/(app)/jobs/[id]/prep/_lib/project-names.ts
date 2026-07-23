import type { Library } from '@/lib/schemas/entities';

// PRP-04 (plan §2.5 / D12) — projectId → project name, for labelling each rehearsal
// question's source project ("angle") in question-list.tsx (Deliverable 3). Pure.
//
// THIS MODULE'S OWN COPY, mirroring 05-tailor/resume/_lib/project-names.ts. Per-module
// duplication is the deliberate breakdown-plan.md §3 decision — this is NOT imported from
// 05-tailor, and must NOT be imported by other modules (same rule the ticket invokes for
// dropped-count-header.tsx).
//
// Consumers fall back to the raw `projectId` for any id not in the map: a library edited
// AFTER a Brief was generated can drop an id the questions still reference (plan D10). Empty
// map when `library` is null (the page passes `getLibrary(...)`, which can be null).

/** projectId → project name. Empty when `library` is null. */
export function projectNameMap(library: Library | null): Record<string, string> {
  if (!library) return {};
  const map: Record<string, string> = {};
  for (const project of library.projects) {
    map[project.id] = project.name;
  }
  return map;
}
