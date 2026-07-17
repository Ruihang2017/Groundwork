import { z } from 'zod';

// Pipeline stage payload schemas (PRD §5.1 stage table, §5.2 Fit Report,
// §5.3 Tailor, §5.4 Prep). These are the *output contract* for every pipeline
// stage — the first line of PRD §5.5's trust boundary ("所有 stage 输出先过
// Zod v4 schema，再执行四层过滤"). This file is intentionally independent of
// lib/schemas/entities.ts: any "project reference" field below is a plain
// z.string(), validated against the live library at runtime by FND-07 (§5.5
// layer 1), NOT by cross-schema Zod composition. Do not import from entities.ts.

// --- READ stage (JdExtract) -------------------------------------------------

// PRD §5.1 READ row: "每条打 category（technical / experience / domain / logistics）".
export const RequirementCategory = z.enum([
  'technical',
  'experience',
  'domain',
  'logistics',
]);
export type RequirementCategory = z.infer<typeof RequirementCategory>;

// PRD §5.1 READ row: "requirements ≤ 11、weight 1–3（3 = 没有就不招）、每条打
// category…；atsKeywords 列表；subtext ≤ 3". `requirements[].id` is the join key
// CROSS's Binding/Gap reference via `requirementId` — do not drop it.
export const JdExtract = z.object({
  requirements: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        weight: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        category: RequirementCategory,
      }),
    )
    .max(11),
  atsKeywords: z.array(z.string()),
  subtext: z.array(z.string()).max(3),
});
export type JdExtract = z.infer<typeof JdExtract>;

// --- CROSS stage (Ledger = Binding[] ∪ Gap[]) -------------------------------

// PRD §5.1 SCORE row: "strong=1 / partial=0.5 / gap=0". `gap` is deliberately
// EXCLUDED from this enum: a gap is not a binding with strength 'gap', it lives
// in the separate `gaps` array (Ledger below). Load-bearing shape decision —
// see the ticket's Feedback obligation #2.
export const BindingStrength = z.enum(['strong', 'partial']);
export type BindingStrength = z.infer<typeof BindingStrength>;

// PRD §5.1 CROSS row: "binding 必须引用库条目中的具体技术细节" + §5.5 layer 1:
// "projectId ∈ library". `projectId`/`requirementId` are plain z.string() here —
// the referential-integrity check against the live library is FND-07's job, not
// this schema's (see file header; no regex, no import from entities.ts).
export const Binding = z.object({
  requirementId: z.string(),
  projectId: z.string(),
  strength: BindingStrength,
  evidence: z.string(),
});
export type Binding = z.infer<typeof Binding>;

// PRD §5.1 CROSS row: "gap 必须给 probe（他们会怎么问）+ play（具体桥接话术）".
export const Gap = z.object({
  requirementId: z.string(),
  probe: z.string(),
  play: z.string(),
});
export type Gap = z.infer<typeof Gap>;

// PRD §5.1 CROSS row: "每条 requirement 恰好落入 bindings ∪ gaps 之一" — a
// disjoint union encoded as two arrays, NOT a single tagged array. FND-07's
// layer-2 requirement-coverage check reads this shape; do not restructure it.
export const Ledger = z.object({
  bindings: z.array(Binding),
  gaps: z.array(Gap),
});
export type Ledger = z.infer<typeof Ledger>;

// --- SCORE stage (FitReport) ------------------------------------------------

// PRD §5.2: "硬性条件（签证 / 地点 / 年限 / 语言）逐条 pass / fail / unknown，
// 置顶展示". `label` holds which hard requirement this is; PRD names the four
// *kinds* as prose guidance, not as a closed enum of label strings, so `label`
// stays z.string().
export const HardRequirementCheck = z.object({
  label: z.string(),
  status: z.enum(['pass', 'fail', 'unknown']),
});
export type HardRequirementCheck = z.infer<typeof HardRequirementCheck>;

// PRD §5.2: "四个子分（0–100）…各自列出支撑 bindings 与 gaps，分数可下钻到证据".
// `bindings`/`gaps` hold the referenced requirementId strings / Binding/Gap
// index references — the exact indexing convention is left to FIT-02; this
// schema only fixes that both arrays exist and are string arrays.
export const SubScore = z.object({
  score: z.number().min(0).max(100),
  bindings: z.array(z.string()),
  gaps: z.array(z.string()),
});
export type SubScore = z.infer<typeof SubScore>;

// PRD §5.2: "≥75 Strong / 55–74 Competitive / 35–54 Stretch / <35 Long shot".
// 'Long shot' contains a space — transcribed exactly as PRD states it.
export const FitTier = z.enum(['Strong', 'Competitive', 'Stretch', 'Long shot']);
export type FitTier = z.infer<typeof FitTier>;

// PRD §5.2 in full: hard requirements, four named sub-scores (技术栈匹配→technical,
// 经验深度→experienceDepth, 领域匹配→domain, 证据强度→evidenceStrength), composite
// score + tier, "档位给建议语 + top gaps（含 probe/play）" → advice + topGaps
// (reusing Gap, which already carries probe/play).
export const FitReport = z.object({
  hardRequirements: z.array(HardRequirementCheck),
  subScores: z.object({
    technical: SubScore,
    experienceDepth: SubScore,
    domain: SubScore,
    evidenceStrength: SubScore,
  }),
  compositeScore: z.number().min(0).max(100),
  tier: FitTier,
  advice: z.string(),
  topGaps: z.array(Gap),
});
export type FitReport = z.infer<typeof FitReport>;

// --- TAILOR stage (Alignment, Edit) -----------------------------------------

// PRD §5.3: "JD 关键词 → 简历中 present / missing / 同义失配（如 'K8s' vs
// 'Kubernetes'）。missing 区分两类：库里有、简历没写 → 改写解决；库里也没有 →
// 显示为 gap". The two-way missing split is encoded as two distinct enum values
// (missing_in_resume vs missing_in_library) so downstream code can branch
// directly rather than re-deriving it.
export const AlignmentEntry = z.object({
  keyword: z.string(),
  status: z.enum([
    'present',
    'missing_in_resume',
    'missing_in_library',
    'synonym_mismatch',
  ]),
  note: z.string().optional(),
});
export type AlignmentEntry = z.infer<typeof AlignmentEntry>;

// PRD §5.6 references TailoredResume.alignment: Alignment as a bare array —
// keep it a z.array(...), do not wrap it in an object.
export const Alignment = z.array(AlignmentEntry);
export type Alignment = z.infer<typeof Alignment>;

// PRD §5.3: "{原文, 建议改写, 理由, 来源 projectId}". Same projectId treatment as
// Binding — plain z.string(), no cross-import, runtime check is FND-07's job.
export const Edit = z.object({
  original: z.string(),
  suggested: z.string(),
  rationale: z.string(),
  projectId: z.string(),
});
export type Edit = z.infer<typeof Edit>;

// --- RESEARCH stage (Intel) -------------------------------------------------

// PRD §5.1 RESEARCH row: "recent ≤ 3（每条带 soWhat）". Each recent item needs a
// content field distinct from soWhat — `headline` is the field name from the
// ticket's Deliverable 14.
export const IntelRecentItem = z.object({
  headline: z.string(),
  soWhat: z.string(),
});
export type IntelRecentItem = z.infer<typeof IntelRecentItem>;

// PRD §5.1 RESEARCH row: "snapshot、recent ≤ 3（每条带 soWhat）、engineering 信号
// ≤ 3、talkingPoints ≤ 3；查无实据返回空数组，禁止编造". No .min(1) anywhere: an
// empty array is an explicitly valid "nothing found" state (.max(3) already
// permits zero-length arrays).
export const Intel = z.object({
  snapshot: z.string(),
  recent: z.array(IntelRecentItem).max(3),
  engineeringSignals: z.array(z.string()).max(3),
  talkingPoints: z.array(z.string()).max(3),
});
export type Intel = z.infer<typeof Intel>;

// --- REHEARSE stage (Rehearse) ----------------------------------------------

// PRD §5.4: "每个问题必须绑 projectId…trap = 标准答案之后的第二问". `trap` is
// non-empty (.min(1)) per the ticket's Deliverable 16 ("trap 非空").
export const RehearseQuestion = z.object({
  projectId: z.string(),
  question: z.string(),
  trap: z.string().min(1),
});
export type RehearseQuestion = z.infer<typeof RehearseQuestion>;

// PRD §5.4 / §5.1 REHEARSE row: "questions[5] + askThem[3] + positioning".
// Exactly 5 / exactly 3 via .length(), not .max().
export const Rehearse = z.object({
  questions: z.array(RehearseQuestion).length(5),
  askThem: z.array(z.string()).length(3),
  positioning: z.string(),
});
export type Rehearse = z.infer<typeof Rehearse>;
