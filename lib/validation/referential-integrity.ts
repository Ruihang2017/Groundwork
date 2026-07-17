import type { Library } from '@/lib/schemas/entities';

// PRD §5.5 layer 1: "projectId ∈ library，否则从 bindings / edits / questions 中
// 移除，dropped 计数随响应返回，前端可查看被弃原始条目（透明性）". Generic over
// any array of objects carrying a `projectId` field — Binding (FND-03),
// Edit (FND-03), RehearseQuestion (FND-03) all structurally satisfy this
// constraint; do NOT write three copies of this filter.
//
// Pure function: no mutation of `items` (returns new arrays), no DB access.
export function filterByReferentialIntegrity<T extends { projectId: string }>(
  items: T[],
  validProjectIds: Set<string>,
): { result: T[]; dropped: Array<{ item: T; reason: 'projectId not in library' }> } {
  const result: T[] = [];
  const dropped: Array<{ item: T; reason: 'projectId not in library' }> = [];

  for (const item of items) {
    // Exact, case-sensitive string match. Project.id is already schema-
    // constrained to lowercase kebab-case (FND-02's PROJECT_ID_PATTERN); a
    // case-mismatched projectId in generated output is exactly the kind of
    // hallucinated/mismatched reference this layer exists to catch and drop
    // transparently — do NOT case-normalize "for robustness".
    if (validProjectIds.has(item.projectId)) {
      result.push(item);
    } else {
      dropped.push({ item, reason: 'projectId not in library' });
    }
  }

  return { result, dropped };
}

// Convenience for callers — builds the Set filterByReferentialIntegrity needs
// from a Library's Project.id list (FND-02: kebab-case, PROJECT_ID_PATTERN-
// constrained at the schema layer already; no re-validation of the pattern
// here, only membership).
export function getValidProjectIds(library: Library): Set<string> {
  return new Set(library.projects.map((project) => project.id));
}
