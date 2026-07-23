# 05-tailor — Sub-PRD

| | |
|---|---|
| 版本 | v0.2 |
| 日期 | 2026-07-23 |
| 上游 | [docs/PRD.md](../../PRD.md) §3 C3, §4 S3, §5.1 TAILOR, §5.3, §5.7, §10 P3, §13 Q2 |
| 状态 | Draft → Gate 1 评审 |

## 问题

PRD §1 F2（一份简历打天下）："逐岗手工定制一次 1–2 小时，没人坚持得下来，于是定制根本不发生。" PRD §3 明确本模块是"核心业务"（C3 简历定制）——北极星指标（PRD §7）"每周导出的定制简历份数"直接由本模块产出。

## 范围 / Non-goals

**范围**：PRD §3 C3——TAILOR stage（关键词对齐表 + 逐条 edits + 全文草稿）+ 对齐表/edits 审阅 UI + 全文编辑器 + 打印导出。

**Non-goals**：

- 不做 Prep 的任何内容——`06-prep`。本模块与 `06-prep` 互相没有依赖（见 `docs/prd/breakdown-plan.md` §4 的并行车道说明），两者可在各自依赖（本模块另需 `03-library`/LIB-02）合并后并行推进。
- 不做 Cover letter 生成——PRD §11 V1.2，触发条件未达。
- 不做简历模板系统——PRD §13 Q2 明确"P3 实测，不行则提前引入模板"；本模块先按打印 CSS 方案交付，模板系统是该开放问题的后备方案，非本模块默认范围。
- 不实现 `closed` 状态触发——延续 `04-fit/README.md` 的决定，v1 不实现。
- 不做简历原文（`resumes` 表）持久化——已由 `03-library`/LIB-02 承担；本模块只读取。

## 决策

| 决策 | 依据（PRD §） |
|---|---|
| `job.status` 转为 `applied` 由本模块提供一个手动"标记为已投递"按钮，调用 `04-fit`/FIT-01 已建的通用状态 PATCH 路由，不新建路由 | `04-fit/README.md` 已决定通用状态路由放在 `04-fit`；PRD 未定义 `applied` 触发方式，本模块采用最保守默认（手动，非自动） |
| 导出走"打印友好页 → 浏览器打印 PDF"，不引入模板引擎 | §5.3 "全文草稿：markdown 就地编辑；导出 = 打印友好页 → 浏览器打印 PDF（模板系统进 roadmap）" |
| 数字完整性校验直接复用 `01-foundation`/FND-07 的 `filterNumberIntegrity`，输入取真实 `Resume.sourceMd`（`03-library`/LIB-02 提供），不在本模块重新实现或反推 | §5.5 layer 3 已在 FND-07 实现；§5.3 "服务端 regex 交叉校验，违规条目剔除并计数展示"；PRD §5.1 TAILOR 行的输入本就是"`resumeMd` + …"，即真实源简历文本 |
| **D1**（TLR-01 Builder）：TAILOR 的模型输入取 `job.jd`（`JdExtract`）+ `job.ledger` + 库（去 `profile.contact`）+ `resume.sourceMd`，**不发 `job.jdRaw`** | PRD §5.1 TAILOR 行输入即 "`resumeMd + JdExtract + Ledger`"（是 JdExtract 而非原始 JD）；`jdRaw` 是未净化的攻击面，重发会翻倍付费输入 token 并重新暴露注入面——与 CROSS/FIT-02 D1 一致。默认交付 `jd`-only（见开放问题 Q1） |
| **D5**（TLR-01 Builder）：重跑 Tailor 覆盖旧草稿（一 job 一行），不设 `already_tailored` 闸门 | 每次调用都在付费前扣一次 `tailor` 配额（5/天），无 FIT-02 那种"一次扣费无限调用"的滥用面；PRD 把 Tailor 定位为可重跑的按岗动作，非版本历史 |

## 拒绝的备选方案

- **对齐表/edits 做成整篇黑盒替换**：拒绝——直接违反 §5.3"用户逐条采纳，不是黑盒整篇替换"的明文要求。
- **关键词密度优先于可读性**：拒绝——§5.3"可读性优先于关键词密度"是明文规则，本模块的 prompt 与 UI 都不得引导用户/模型堆砌关键词。
- **数字完整性校验从 `Library` 字段反推源简历文本（不查 `resumes` 表）**：拒绝——曾是初稿的临时方案，会漏判"简历原文有但从未写进 `Project.summary`/`metrics` 的数字"，导致合法数字被误删；已改为 TLR-01 直接读取 `03-library`/LIB-02 持久化的真实 `Resume.sourceMd`（见 `docs/prd/breakdown-plan.md` §6 开放问题 #10）。

## 开放问题

| # | 问题 | Owner |
|---|---|---|
| 1 | 导出保真：打印 CSS 能否达到"可直接投递"观感（PRD §13 Q2） | Horace（product）——TLR-02 交付打印 CSS 方案，"可直接投递"判断是 `[human]` 验收项，未达标则触发模板系统立项（不在本 v1 票据范围内） |
| 2 | TAILOR 的调好 prompt（附录A 提及"PARSE / TAILOR 为新增"——即 TAILOR 本就没有遗留 prompt 可迁移） | 无需 Horace 裁决——PRD 附录A 原文已明确 TAILOR 是新增，本模块从零编写，不存在资产交接缺口 |
| Q1 | TLR-01 的 Deliverable 3(f) 字面写"`job.jdRaw`/`job.jd`"，是否有意包含原始 JD？TLR-01 Builder 依 PRD §5.1 + 安全 + FIT-02 D1 先例定为 `jd`-only（D1）。若 Horace 意在为关键词对齐保真而发原始 JD，则是 prompt 输入变更（并重开注入面决策）。默认交付：`jd`-only | Horace / 票据作者 |
| Q3 | `edits[].suggested` 是否也应过数字完整性校验？TLR-02 导出用户手改后的草稿前是否需再跑一次 `filterNumberIntegrity`？TLR-01 只过 `fullDraftMd`（Deliverable 3(h)）；`edit.suggested` 里的杜撰数字若被用户在 TLR-02 编辑器采纳，会绕过校验进入导出稿。最干净的修法是 TLR-02 在导出时对最终稿再跑一次过滤 | Horace + TLR-02 的 Architect pass |

## 工作分解

| 票据 | 标题 | Size | Lane | 主要文件范围 | 依赖 |
|---|---|---|---|---|---|
| TLR-01 | TAILOR API 路由 | M | 05-tailor | `app/api/jobs/[id]/tailor/route.ts`, `lib/db/queries/tailored-resumes.ts` | FND-03, FND-04, FND-05, FND-06, FND-07, FND-10, FIT-02, EVL-02, LIB-02 |
| TLR-02 | 对齐表/edits UI + 全文编辑器 + 导出 | M | 05-tailor | `app/(app)/jobs/[id]/resume/**` | TLR-01, FIT-01 |

## 模块级验收

- [ ] `[fixture]` `pnpm eval` 的 Q1 数字完整性断言违规数 = 0（PRD §10 P3 "数字完整性违规 = 0"）。
- [ ] `[human]` Horace 确认导出 PDF 达到"可直接投递"观感（PRD §10 P3；若未达标，记录为触发模板系统立项的证据，走 PRD §13 Q2 流程，不在本模块内自行决定引入模板引擎）。
- [ ] `[machine]` TAILOR 输出的 `fullDraftMd` 中任何数值都能在真实源简历（`03-library`/LIB-02 持久化的 `Resume.sourceMd`）或库 metrics 中找到（FND-07 `filterNumberIntegrity` 的直接断言）。

## Changelog

- v0.1（2026-07-17）：初稿，随 `/breakdown-prd` 生成。
- v0.1 修订（2026-07-17，Gate 1 前）：TLR-01 改为读取 `03-library`/LIB-02 真实持久化的 `Resume.sourceMd`，不再反推；新增依赖 `LIB-02`；详见 `docs/prd/breakdown-plan.md` §6 开放问题 #10。
- v0.2（2026-07-23，TLR-01 Builder writeback）：记录 TLR-01 交付的两条决策 D1（模型输入取 `JdExtract` 而非 `jdRaw`）与 D5（重跑覆盖旧草稿、不设闸门），新增开放问题 Q1（`jdRaw` 输入是否有意，owner Horace）与 Q3（`edits[].suggested` 与 TLR-02 导出稿是否需再校验数字完整性，owner Horace + TLR-02 Architect）。原开放问题 #1–#2 不变。
