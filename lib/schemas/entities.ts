import { z } from 'zod';

// Profile is not defined in PRD §5.6's code sketch (only referenced by Library).
// FND-02 design addition, not literally specified in PRD §5.6 — kept minimal
// because no downstream stage in PRD §5.1–§5.4 reads individual Profile fields
// directly (they consume Library.projects). Extend here, not with a competing
// shape elsewhere, if a later module (e.g. 03-library's confirm UI) needs more —
// see this ticket's Feedback obligation #1.
export const Profile = z.object({
  name: z.string(),
  headline: z.string().optional(),
  targetRole: z.string().optional(),
  contact: z
    .object({
      // Zod v4: z.email() is the non-deprecated top-level form; z.string().email()
      // (the ticket's literal snippet) still works but is deprecated as of v4 and
      // slated for removal in the next major version — same validation behavior,
      // preferring the form that isn't already on a deprecation path.
      email: z.email().optional(),
      links: z.array(z.string()).default([]),
    })
    .optional(),
});
export type Profile = z.infer<typeof Profile>;

// PRD §5.6 comment: kebab-case，如 "voice-agent". Reject uppercase, spaces,
// underscores, leading/trailing hyphens, and doubled hyphens. Exported so
// callers/tests can reference the exact pattern without re-deriving it.
export const PROJECT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Literal transcription of PRD §5.6's Project sketch — field list, types, and
// order match exactly; no constraints added beyond what §5.6 states (e.g. no
// `.min(1)` on metrics — empty metrics is an explicitly valid, displayed state).
export const Project = z.object({
  id: z
    .string()
    .regex(PROJECT_ID_PATTERN, 'Project.id must be kebab-case, e.g. "voice-agent"'), // kebab-case，如 "voice-agent"
  name: z.string(),
  stage: z.string(),
  role: z.string(),
  stack: z.array(z.string()),
  summary: z.string(), // 2–3 句技术实质：架构决策、tradeoff，不是职责描述
  metrics: z.array(z.string()), // 只允许真实数字；空数组是合法且被显式展示的状态
  tags: z.array(z.string()),
});
export type Project = z.infer<typeof Project>;

export const Library = z.object({
  profile: Profile,
  projects: z.array(Project),
});
export type Library = z.infer<typeof Library>;

// 原件解析后即弃，不落盘 (source discarded after parse; not persisted)
export const Resume = z.object({
  sourceMd: z.string(),
  updatedAt: z.number(),
});
export type Resume = z.infer<typeof Resume>;
