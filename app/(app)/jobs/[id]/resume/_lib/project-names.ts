import type { Library } from '@/lib/schemas/entities';

// TLR-02 (plan §3.4) — projectId → project name, for resolving an `Edit.projectId` to a
// human label in edit-card.tsx (Deliverable 2). Pure.
//
// Consumers fall back to the raw `projectId` for any id not in the map: a library edited
// AFTER a draft was generated can drop an id the edits still reference (plan R4). Empty
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
