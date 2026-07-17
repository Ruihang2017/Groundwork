# PRD — Groundwork

| | |
|---|---|
| 版本 | v2.0 |
| 日期 | 2026-07-17 |
| Owner | Horace |
| 状态 | Draft → 评审后开工 |
| 性质 | 独立开发、公开上线的 web 产品；AI 协作开发（Claude Code） |
| 本文边界 | 只定死重大决策：产品方向、核心流程、技术栈、质量红线。字段级 schema 与 prompt 细节随实现以 feature spec 落定 |

---

## 0. 一句话

把求职者的真实经历（简历）解析成**结构化背景库**，在求职漏斗的每一步兑现为可辩护的产出：

```
Resume ──parse──► Library（一次构建、持续增值的资产）

Library × JD          → Fit Report（筛：该不该投，多维打分）
Library × JD          → Tailored Resume（投：关键词对齐的定制简历）
Library × JD × Intel  → Interview Brief（面：gap 分析 + 问题预测）
```

一库三用。每个输出的每条声明都绑定库中一段真实经历，绑不上的显式标记为 gap——这是本产品与所有"AI 求职工具"的分界线。

---

## 1. 背景与问题

求职漏斗的三个真实失败模式：

**F1 — 盲投。** 候选人无法快速判断一个 JD 值不值得投：匹配度靠感觉，时间花在不可能命中的岗位上，或错过本可命中的岗位。

**F2 — 一份简历打天下。** HR 与 ATS 按关键词筛选，通用简历在关键词上系统性失配。逐岗手工定制一次 1–2 小时，没人坚持得下来，于是定制根本不发生。

**F3 — 面试准备通用化。** 市面 AI 面试工具只吃 JD 单一输入，输出必然是任何候选人都适用的题库；且候选人清楚自己会讲什么，不清楚会被追问什么、追问到哪一层露底——面试是在 gap 上被决定的，不是在强项上。

三个失败模式共同根因：**候选人的真实经历从未被结构化**，每一步都靠临时回忆，劳动不沉淀。因此产品结构固定：库是资产，JD 是流量；漏斗每一步都是库的一次变现，库的深度决定所有输出的上限。

---

## 2. 产品原则（不可协商）

**P1 — Bind, don't write。** 任何产出条目（fit 证据、简历改写、预测问题）必须携带真实存在的 `projectId`。模型输出经服务端 referential integrity 校验，绑不上的条目直接丢弃并计数展示。在简历定制场景，这条原则升格为产品底线：**只重组、换措辞、调强调，永不替用户编造技能和事实**——缺什么显示为 gap，不写进简历。prompt 会漂移，校验不会。

**P2 — Retrieve, don't generate。** 数字永不虚构。库中项目没有 metrics，界面显示 "no metrics" 警告且绑定强度封顶 `partial`；定制简历中出现的任何数值必须存在于源简历或库中（服务端校验）。空白是一种展示状态，不是待填充的洞。

**P3 — Degrade, don't block。** 公司情报等外部依赖是 best-effort：失败标记 fail，主产出照常。任何单阶段故障不得阻塞整条 pipeline 的可用输出。

**P4 — Pay at the gate。** 成本沿漏斗递增：筛选（高频）必须便宜，重操作（web 搜索、面试简报）只在用户显式进入下一阶段时发生。免费产品的成本纪律建在结构里，不建在自觉里。

---

## 3. 范围

### v1（上线范围）

| # | 能力 | 一句话 |
|---|---|---|
| C1 | 简历导入建库 | PDF/DOCX/粘贴 → markdown + 结构化草稿库 → 用户确认微调。**导入是主路径**，手工填写只是补充与深化 |
| C2 | Fit Report | 贴 JD → 硬性条件核对 + 多维打分（技术/经验/领域/证据强度）+ 综合分与档位建议 |
| C3 | 简历定制（核心业务） | 关键词对齐表 + 逐条改写建议（每条注明来源项目）+ 全文草稿 + 导出 |
| C4 | 面试简报 | 拿到面邀后解锁：公司情报 + gap 分析 + 预测问题（含追问）+ 该问对方什么 |
| C5 | 上线基线 | 注册登录、用量配额、隐私政策与删号、备份、成本与质量可观测 |

### v1 不做

| 不做 | 去向 |
|---|---|
| 面后回填 / 命中率闭环 | V1.1（§11） |
| Cover letter 生成 | V1.2 |
| 浏览器插件 / URL 抓取 | V1.3（插件读用户自己登录页，绕开反爬战争） |
| 语音 mock 面试 | V1.4（预测命中率达标后，否则是在排练错题） |
| 计费 / 商业化 | V2（v1 免费 + 配额） |
| 向量库 / RAG、LangChain | 永不：单用户库 < 50 条全量进 context；Zod 边界 + 裸 fetch 足够 |
| 移动 App | 永不：响应式 web 够用 |

---

## 4. 用户与核心流程

**目标用户**：正在批量投递的科技岗求职者（SWE / AI / Data，英文市场 JD）。开发者本人属于该画像，作为 0 号用户 dogfood；产品分歧以画像与数据裁决，不以个人偏好裁决。

漏斗即产品的信息架构：**建库（一次）→ 筛（每个 JD）→ 投（决定投才做）→ 面（拿到面邀才解锁）**。

- **S1 · 建库** — 上传简历 PDF → 约 30s 得到 markdown 全文 + 结构化草稿库（项目、技术栈、真实数字）→ 逐条确认/微调 → 库建成。
- **S2 · 筛** — 刷到心动岗位 → 全选粘贴 JD → 30s 内拿到 Fit Report：硬性条件核对、四维子分、综合分与档位、核心 gaps → 决定投不投。
- **S3 · 投** — 点击 Tailor → 关键词对齐表 + 逐条改写建议（每条注明来源项目，逐条采纳）+ 定制全文草稿 → 就地编辑、导出 → 投递。每一份投出去的简历都是定制的。
- **S4 · 面** — 收到面试邀请 → 将 job 标记为 interviewing → 解锁 Prep → 生成简报（公司情报 + ledger + 预测问题与追问）→ 面前按 angle 排练。
- **S5 · 复利** — 库每补一个真实数字、每加一个项目，所有未来的 fit / tailor / brief 上限同时抬升。换方向的 JD，库不动，交叉结果自动不同。

---

## 5. 核心功能规格

### 5.1 Pipeline：阶段式调用，客户端编排

客户端按操作发起 1–3 次独立 API 调用而非服务端单个大 job：窄 schema 分阶段输出质量显著优于单次大 prompt；天然规避 serverless 单请求时长限制；进度 UI 免费获得；外部依赖可独立降级（P3）。

| Stage | 触发 | 输入 → 输出 | 关键规则 | 失败策略 |
|---|---|---|---|---|
| **PARSE** | 导入简历 | 文件/文本 → `resumeMd` + 草稿 Library | metrics 只取简历中出现的真实数字（P2）；草稿必须经用户确认才成为库 | 解析失败 → 引导粘贴纯文本 |
| **READ** | 新建 job | `jdRaw` → `JdExtract` | requirements ≤ 11、weight 1–3（3 = 没有就不招）、每条打 category（technical / experience / domain / logistics）；atsKeywords 列表；subtext ≤ 3 | JSON 修复重试 1 次 → 报错 |
| **CROSS** | Fit | `JdExtract × Library` → `Ledger` | 每条 requirement 恰好落入 bindings ∪ gaps 之一；binding 必须引用库条目中的具体技术细节；无量化 PoC 遇 scale/production 类要求封顶 `partial`（P2）；gap 必须给 probe（他们会怎么问）+ play（具体桥接话术） | 同上 |
| **SCORE** | Fit（纯代码） | `Ledger` + weights → `FitReport` | 子分与综合分是 ledger 的确定性函数（strong=1 / partial=0.5 / gap=0，按 requirement weight 加权归一）；**模型不输出分数** | n/a |
| **TAILOR** | 用户决定投 | `resumeMd + JdExtract + Ledger` → 对齐表 + edits + 全文草稿 | 每条 edit 绑 `projectId`（P1）；数字完整性校验（P2）；缺失技能 → gap 提示、不入文；可读性优先于关键词密度 | JSON 修复重试 1 次 → 报错 |
| **RESEARCH** | 进入 Prep | company + role → `Intel`（web_search tool） | snapshot、recent ≤ 3（每条带 soWhat）、engineering 信号 ≤ 3、talkingPoints ≤ 3；查无实据返回空数组，禁止编造 | 失败标记 fail，简报照常（P3） |
| **REHEARSE** | 进入 Prep | 全部上文 → questions[5] + askThem[3] + positioning | 每个问题必须绑 projectId 且只因该项目的具体内容才可问（能问任何候选人 = 无效）；trap = 标准答案之后的第二问；askThem 必须是不做研究问不出的问题 | 同上 |

延迟预算（p50）：**Fit ≤ 30s；Tailor ≤ 45s；Prep ≤ 90s**。全程 streaming 展示进度。

### 5.2 Fit Report（筛）

- **硬性条件**（签证 / 地点 / 年限 / 语言）逐条 pass / fail / unknown，置顶展示。
- **四个子分**（0–100）：技术栈匹配、经验深度、领域匹配、证据强度——各自列出支撑 bindings 与 gaps，分数可下钻到证据。
- **综合分 + 档位**：≥75 Strong / 55–74 Competitive / 35–54 Stretch / <35 Long shot。档位给建议语 + top gaps（含 probe/play）。
- **诚实标注**：分数是启发式匹配度，**不是录取概率**——在 V1.1 有真实结果回填之前不得暗示统计意义。低分页面同时展示"如果仍要投，优先补哪两个 gap"。

### 5.3 简历定制（投）——核心业务

- **关键词对齐表**：JD 关键词 → 简历中 present / missing / 同义失配（如 "K8s" vs "Kubernetes"）。missing 区分两类：库里有、简历没写 → 改写解决；库里也没有 → 显示为 gap，绝不写入简历。
- **逐条 edits**：`{原文, 建议改写, 理由, 来源 projectId}`，用户逐条采纳，不是黑盒整篇替换。
- **全文草稿**：markdown 就地编辑；导出 = 打印友好页 → 浏览器打印 PDF（模板系统进 roadmap）。
- **完整性**：输出中任何数值必须存在于源简历或库 metrics（服务端 regex 交叉校验，违规条目剔除并计数展示）。

### 5.4 面试简报（面）

ledger + intel + 预测问题 / askThem / positioning，MVP 已验证的四阶段 prompts 作为基线迁移。解锁条件：`job.status = interviewing`（用户点击"我拿到面试了"）——这是 P4 的门。

### 5.5 服务端校验（信任边界）

所有 stage 输出先过 Zod v4 schema，再执行四层过滤：

1. **Referential integrity**：`projectId ∈ library`，否则从 bindings / edits / questions 中移除，dropped 计数随响应返回，前端可查看被弃原始条目（透明性）。
2. **Requirement 覆盖检查**：READ 提取的 requirement 未在 CROSS 输出中出现 → 自动补入 gaps（标记 `uncovered — rerun`）。宁可暴露不完整，不静默吞掉。
3. **数字完整性（TAILOR）**：产出中的数值不存在于源简历/库 → 剔除并计数（P2 的机器实现）。
4. **废话黑名单**（regex）：`be honest` / `stay calm` 类命中即标记 low-quality，记录不阻断——作为 prompt 回归信号。

### 5.6 数据模型（Zod v4 + Drizzle / Postgres）

```ts
const Project = z.object({
  id: z.string(),               // kebab-case，如 "voice-agent"
  name: z.string(), stage: z.string(), role: z.string(),
  stack: z.array(z.string()),
  summary: z.string(),          // 2–3 句技术实质：架构决策、tradeoff，不是职责描述
  metrics: z.array(z.string()), // 只允许真实数字；空数组是合法且被显式展示的状态
  tags: z.array(z.string()),
});
const Library = z.object({ profile: Profile, projects: z.array(Project) });
const Resume  = z.object({ sourceMd: z.string(), updatedAt: z.number() }); // 原件解析后即弃，不落盘

// 漏斗主实体：job 携带状态推进，ledger 产出一次、三处复用
const Job = z.object({
  id: z.string(), userId: z.string(), company: z.string(), role: z.string(),
  status: z.enum(['screening', 'applied', 'interviewing', 'closed']),
  jdRaw: z.string(), jd: JdExtract,
  ledger: Ledger,               // bindings + gaps（Fit 产出，Tailor / Prep 复用）
  fit: FitReport,               // 硬性条件 + 4 子分 + 综合分（代码计算）
});
const TailoredResume = z.object({ jobId: z.string(), alignment: Alignment, edits: z.array(Edit), fullDraftMd: z.string() });
const Brief = z.object({ jobId: z.string(), intel: Intel.nullable(), rehearse: Rehearse });

// 记账：成本与延迟从第一天可观测
const UsageEvent = z.object({ userId: z.string(), op: z.string(), tokensIn: z.number(),
  tokensOut: z.number(), searches: z.number(), costUsd: z.number(), durationMs: z.number() });
```

Postgres 表：`users / libraries / resumes / jobs / tailored_resumes / briefs / usage_events / eval_runs`。库为资产：写操作留 `updatedAt`，删除为软删防手滑；**删号 = 硬删该用户全部数据**。

### 5.7 UX 页面与门控

| 页面 / 状态 | 规则 |
|---|---|
| Jobs 列表 | 每个 job 带状态 chip：screening → applied → interviewing → closed；无库时禁止新建 job，CTA 引导导入简历——垃圾进垃圾出，库太薄时产出通用结果等于自毁定位 |
| Job 详情 | Fit / Resume / Prep 三段推进；Prep 在 interviewing 前锁定（文案："拿到面邀后解锁"） |
| Library | 导入后草稿确认流；项目无 metrics 时页顶红字盘点 + 卡片级警告（P2 界面化） |
| 产出展示 | dropped > 0 表头计数、可展开被弃条目；research fail 标红但简报照常渲染 |

### 5.8 语言

UI 英文；fit / tailor / brief 输出语言跟随 JD（v1 官方支持英文 JD）。库 summary 双语皆可（模型双语可读），评测含双语 fixture 验证 CROSS 质量不劣化。

---

## 6. 质量标准与评测

"做好"不是形容词，是四道门。前三道进 CI 习惯（`pnpm eval`，每次 prompt / 模型改动必跑，报告落 `eval_runs`），第四道来自真实世界。

**Fixtures**：10 份真实 JD（5 × AI/ML Engineer、3 × Senior SWE、2 × 对抗样本：极薄 JD、recruiter 灌水 JD）+ 3 份简历（1 份真实授权、2 份合成，覆盖不同 seniority）。

| 门 | 类型 | 断言 | 阈值 |
|---|---|---|---|
| **Q1 结构门** | 确定性 | schema 通过率（含 1 次 repair）；requirement 覆盖恰好一次；questions == 5 且 trap 非空；**tailor 数字完整性违规 = 0**；dropped 率 | 通过率 100%；dropped < 15%（高 dropped 说明 prompt 在瞎绑） |
| **Q2 接地门** | LLM judge（Haiku 4.5） | evidence 能否从对应库条目推出；**每条简历改写能否从源简历/库推出**；gap 的 play 是否具体可执行 | 接地 ≥ 95%；fail 样本人工复核，属实则修 prompt 并固化为回归用例 |
| **Q3 特异门** | judge | 预测问题能否问任何一个随机候选人？能 → fail | ≥ 90% 特异 |
| **Q4 真实世界门** | 人工 → 产品化 | 面后勾选"实际被问 vs 预测覆盖"（V1.1 起产品内闭环） | 命中率 ≥ 50%（§7） |

**模型升级政策**：模型 pin 在 config——v1 基线 `claude-sonnet-5`，judge `claude-haiku-4-5`。任何升级必须先全量通过 Q1–Q3 再切；这条政策本身就是 Q1–Q3 存在的理由之一。

---

## 7. 指标

北极星：**每周导出的定制简历份数**——最接近"真实投递被本产品服务"的可测代理。

| 类 | 指标 | 初始目标（上线两周后以真实数据校准基线） |
|---|---|---|
| 激活 | 注册 → 库建成 | ≥ 50% |
| 漏斗 | fit → tailor 转化 | ≥ 25% |
| 漏斗 | interviewing 状态 job 中生成 brief 的比例 | ≥ 60% |
| 质量 | 证据 / 改写幻觉 P0 | = 0（发现 → 24h 修 prompt + 样本固化进 Q2 回归） |
| 质量 | 预测命中率（V1.1 起可测） | ≥ 50% |
| 体验 | p50 延迟 | Fit ≤ 30s / Tailor ≤ 45s / Prep ≤ 90s |
| 成本 | 单次操作 | Fit ≤ $0.10 / Tailor ≤ $0.10 / Prep ≤ $0.30 |

---

## 8. 技术方案（定死）

### 8.1 选型

**Next.js 15 (App Router) + TypeScript + Zod v4 + Drizzle + Neon Postgres + Auth.js v5（Google OAuth + email magic link via Resend）+ Vercel + Anthropic Messages API（pin `claude-sonnet-5`）。**

相对上一版自托管方案的三处改变，全部由"公开上线"这一决策强制：

1. **托管：自有硬件 → Vercel + Neon。** 自托管的原始理由是"自己的数据不出自己的硬件"；面向公众后逻辑反转——**别人的简历不该躺在个人电脑上**。托管平台给出正确的可用性、TLS、备份与合规姿态，免费额度覆盖 v1。
2. **认证：Cloudflare Access allowlist → Auth.js。** allowlist 只适用于受邀名单，公开注册需要真实 auth。选 Auth.js 而非 Clerk：无 per-MAU 供应商依赖，Drizzle adapter 成熟，免费。
3. **DB：SQLite → Neon Postgres。** serverless 部署下 SQLite 单文件模型不成立；Postgres 是多用户的无聊正确解，Drizzle 让迁移成本一次付清。

**简历解析**：PDF 走 Anthropic 原生 document input（对版式鲁棒，免解析库）；DOCX 经 mammoth 提取文本；兜底粘贴纯文本。**原始文件解析后即弃、不落盘**——只存 markdown 与结构化库。这是隐私决策，顺带消灭了文件存储依赖。

**显式排除**：向量库（单用户语料 < 50 条，全量进 context）；LangChain / LlamaIndex（Zod 边界 + 裸 fetch 足够）；Redis（配额用 Postgres 计数器）；容器编排（平台化后不存在这个问题）。

**供应商决策记录 — 为什么不是 DeepSeek（单价便宜约一个数量级）**：v1 拒绝，触发式重审。① 配额结构下月 API 成本 < $50，省下的几十美元买不回复杂度；② RESEARCH 依赖原生 web_search、PARSE 依赖原生 PDF document input——DeepSeek 两者皆无，需自建搜索（Tavily 等，又一个付费依赖）与 PDF 解析，且这两个阶段仍得留在 Anthropic，形成双供应商架构；③ 简历是 PII，英文/澳洲目标市场对"数据经中国服务器处理"的信任与合规顾虑是真实采用障碍（多国政府设备禁令在案），与 §8.3 的隐私承诺直接冲突；④ 产品全部赌注押在绑定纪律与不造假上（Q2 ≥ 95%），恰是模型能力差异最敏感处。**重审触发**：V2 规模化、月 API 成本成为真实约束时——届时任何供应商切换以 Q1–Q3 全量通过为门，评测门让换模型变成实验而非争论。成本优先级更高的杠杆是 Anthropic 内部分层（§9）。

### 8.2 架构

```
Browser（Next.js client；每操作 1–3 次阶段式 fetch，SSE streaming 进度）
        │  Auth.js session（Google OAuth / email magic link via Resend）
Vercel — Next.js 15 serverless
 ├─ /api/parse · /api/read · /api/cross(+score) · /api/tailor · /api/research · /api/rehearse
 │        └──► Anthropic Messages API（pin claude-sonnet-5；research 挂 web_search；parse 走 PDF document input）
 ├─ Zod v4 边界 + referential / number integrity + 配额检查 + usage_events 记账
 └─ Drizzle ORM ──► Neon Postgres
                      └─ 每周 pg_dump（GitHub Actions cron）→ Cloudflare R2
```

### 8.3 安全与隐私

- `ANTHROPIC_API_KEY` 仅存服务端环境变量，永不进 client bundle。
- 数据隔离：全部查询以 session userId 约束，无跨用户查询路径。
- 简历原件不落盘；删号 = 硬删全部数据；上线前挂 Privacy Policy / ToS 页。
- v1 不接第三方分析（自建 `usage_events` 足够）；用户数据的第三方处理方仅 Anthropic API。
- 配额：per-user 每日 10 fit / 5 tailor / 3 prep；全局日花费熔断阈值（env）；Anthropic Console 月度预算告警。

### 8.4 可观测性

每次操作落 tokens / searches / cost / duration / dropped / stage 状态；`/admin` 页汇总周成本、p50/p95、dropped 率、漏斗转化。不上 APM——一张表加一页汇总就是这个量级 observability 的全部。

---

## 9. 成本与免费策略（诚实账）

定价基准（2026-07 核对）：Sonnet 5 = $2 in / $10 out per MTok（8/31 前介绍价；之后 $3/$15，括号内为回调后估算）；web search $10 / 1,000 次；Haiku 4.5（judge）$1/$5。

| 操作 | 主要调用 | 估算成本 |
|---|---|---|
| 建库 PARSE | 1 次（PDF document input） | ~$0.03 |
| Fit | READ + CROSS（SCORE 为代码，免费） | ~$0.04（$0.06） |
| Tailor | 1 次长输出 | ~$0.05（$0.07） |
| Prep | RESEARCH（含 2–4 次搜索）+ REHEARSE | ~$0.08–0.10（$0.13） |
| **全漏斗单 job** | | **~$0.20（$0.30）** |

成本结构与漏斗形状一致（P4）：高频的筛最便宜，最贵的 prep 只发生在拿到面邀之后。配额下单用户日成本极限 ≈ $1；上线初期以**邀请码控制注册节奏**，全局日熔断兜底。

固定成本：Vercel Hobby / Neon / Resend / R2 免费额度内 = $0；域名 ~$12/yr。免费阶段月 API 成本预期 < $50。**月 API 成本 > $100 才做成本优化**（第一杠杆：PARSE / READ 降级 Haiku 4.5，同一 SDK 零架构成本，估省 30–40%；第二杠杆：prompt caching）——触发式，不预做。Vercel Hobby 限非商业用途：v1 免费无收入合规；V2 商业化时升 Pro（$20/mo），届时成本结构随收入重估。

---

## 10. 里程碑（阶段制，无日历）

本项目由 AI 协作开发，不按日历排期；阶段只按**完成标准（exit criteria）**推进，顺序由数据模型依赖固定。

| 阶段 | 交付 | 完成标准 |
|---|---|---|
| **P0 骨架** | repo、Auth.js、Drizzle schema、Vercel 部署流水线 | 注册/登录可用，空应用在线 |
| **P1 建库** | PARSE + 草稿确认/编辑 UI + Library 页 | 3 份 fixture 简历解析正确；空 metrics 状态正确展示 |
| **P2 Fit** | READ + CROSS + SCORE + 报告页 | Q1 全绿；Q2 接地 ≥ 95% |
| **P3 Tailor** | 对齐表 + 逐条 edits + 全文编辑 + 导出 | 数字完整性违规 = 0；导出 PDF 达到可直接投递的观感 |
| **P4 Prep** | RESEARCH + REHEARSE + 状态门控 | 一个真实 job 全漏斗走通；Q3 ≥ 90% |
| **P5 上线** | 配额、Privacy/ToS、删号、备份、/admin、邀请码 | 上线检查清单全勾；0 号用户完成 ≥ 5 次真实投递 dogfood → public |

---

## 11. Roadmap——触发式，不是日历式

每项都有明确触发条件，条件不满足不动工。核心指标达标前动工路线图上的任何一项，都算 scope creep。

| 版本 | Item | 一句话 | 触发条件 |
|---|---|---|---|
| **V1.1** | 面后回填 + 命中率看板 | 逐题勾选"真被问了吗"，预测质量从此有自动化 ground truth，也是后续 prompt 迭代与 fit 分数校准的训练信号 | 全体用户累计 ≥ 10 场真实面试可回填 |
| **V1.2** | Cover letter 生成 | Tailor 的自然延伸：同一 ledger，另一种文体 | 周导出 ≥ 20 份 或 ≥ 5 位用户主动要求 |
| **V1.3** | 浏览器插件（MV3） | Content script 读用户自己已登录页面 DOM（Seek / LinkedIn），一键回填 JD——"URL 进"的正确解，绕开反爬战争而不是打赢它 | 周新建 job ≥ 50（粘贴摩擦被使用量证明） |
| **V1.4** | 语音 mock 面试官 | Realtime relay + ledger/gaps 作为面试官 system prompt——一个知道你简历、会按 trap 追问的面试官；护城河功能 | V1.1 命中率 ≥ 50%（预测质量配得上被排练） |
| **V1.5** | 引导式库增值 | 简历给广度，AI 追问给深度（tradeoff、数字），人审后入库 | 库单薄成为 Q2 / 用户反馈中的可见瓶颈 |
| **V2.0** | 商业化 | 计费、Vercel Pro、抓取与合规复审 | 留存成型 且 出现主动付费意愿 |

Parking lot（无触发条件，仅记录）：面试官画像（按公开资料预测提问风格）、多语言简报、简历模板系统、STAR 素材库与回答评分。

---

## 12. 风险

| 风险 | 缓解 |
|---|---|
| 免费用户成本失控 | 配额 + 邀请码 + 全局日熔断 + 预算告警（P4 的结构化兜底） |
| 简历 PII 泄露 | 托管平台 + 原件不落盘 + userId 隔离 + 删号硬删 + 不接第三方分析 |
| 定制简历"造假"损害用户与产品信誉 | P1/P2 硬校验（referential + 数字完整性）+ 产品立场明示：缺什么显示 gap，不写进简历 |
| 关键词堆砌毁可读性 | 可读性优先规则 + judge 抽查；对齐表只建议，用户逐条采纳 |
| fit 分数被过度信任（低分劝退本可命中的投递） | 档位 + 证据下钻 + "启发式非概率"标注 + 低分页给补 gap 路径 |
| 简历解析质量参差（扫描版 PDF、花哨模板） | PDF 原生 document input + 粘贴兜底 + 草稿必经人工确认 |
| 模型 / prompt 漂移 | 模型 pin + Q1–Q3 作为升级门（§6） |
| 搜索结果污染（RESEARCH 抓到错误/过时新闻） | 禁编造 + intel 展示来源年份 + 面前人工过一遍 intel 是使用规范 |
| 单人维护 | 无聊技术栈 + eval 回归网 + 托管平台吃掉运维面 |

---

## 13. Open Questions（不阻塞 P0）

1. SCORE 权重与档位切点：先按 §5.1 朴素映射上线，V1.1 回填数据后校准——没有 ground truth 时调参数是迷信。
2. 导出保真：打印 CSS 能否达到"可直接投递"观感？P3 实测，不行则提前引入模板。
3. RESEARCH 是否前移到 Fit 阶段做公司红旗筛查（成本 × 价值待验证，与 P4 冲突需数据裁决）。
4. 产品名与域名最终确认。

---

## 附录 A — 资产复用（起点不是零）

- **MVP artifact**（`interview-brief.jsx`）：三 tab UI、四阶段 pipeline、客户端 referential integrity 已验证可跑 → Prep 部分移植，校验搬服务端。
- **Prompts**：READ / RESEARCH / CROSS / REHEARSE 四条已调通（claude-sonnet-4-6 基线）→ 迁移至 sonnet-5 时过 Q1–Q3；PARSE / TAILOR 为新增。
- **Seed library**（9 个项目）→ 开发 fixture 与 0 号用户的真实库。
- 上一版自托管基础设施（colab-mac-1 / Tunnel / Access）不进主路径。
