# 04-fit — Sub-PRD

| | |
|---|---|
| 版本 | v0.3 |
| 日期 | 2026-07-23 |
| 上游 | [docs/PRD.md](../../PRD.md) §3 C2, §4 S2, §5.1 READ/CROSS/SCORE, §5.2, §5.7, §10 P2 |
| 状态 | Draft → Gate 1 评审 |

## 问题

PRD §1 F1（盲投）："候选人无法快速判断一个 JD 值不值得投"。Fit 是漏斗第二步（S2 筛），也是 `Job` 实体的诞生地——PRD §5.6 把 `Job` 称为"漏斗主实体：job 携带状态推进，ledger 产出一次、三处复用"，意味着本模块不仅产出 Fit Report，还要建立 Job 的生命周期（状态机）供 `05-tailor`/`06-prep` 复用，且必须先于两者交付。

## 范围 / Non-goals

**范围**：PRD §3 C2——READ（JD 解析）+ CROSS（交叉匹配产出 ledger）+ SCORE（纯代码打分）+ Job 创建与状态流转路由 + Fit Report 页 + Jobs 列表页。

**Non-goals**：

- 不做 Tailor/Prep 的任何内容生成——`05-tailor`/`06-prep`。
- 不做 RESEARCH 前移到 Fit 阶段——PRD §13 Q3 明确"与 P4 冲突需数据裁决"，v1 不做，仅记录（见开放问题）。
- 不为 `closed` 状态提供任何 UI 触发——PRD 从未定义其触发方式，v1 不实现（见开放问题）。
- 不做 SCORE 权重/切点的校准——PRD §13 Q1 明确"先按 §5.1 朴素映射上线"，本模块直接实现该朴素映射作为 v1 决定，校准是 V1.1 触发式动作。

## 决策

| 决策 | 依据（PRD §） |
|---|---|
| READ（新建 job）与 CROSS+SCORE（"Fit"操作）在用户体验上是同一次点击的连续两次服务端调用，配额在 READ 发生前扣减一次，覆盖整个"Fit"操作 | §5.1 阶段表：READ 触发="新建 job"，CROSS 触发="Fit"；§4 S2 "全选粘贴 JD → 30s 内拿到 Fit Report"描述为单一连续动作；§8.3 只列出一个"fit"配额桶（非"read"+"cross"两个）。**这是硬到不可逆的架构选择**（改变配额语义与 Job 状态机），已在 `docs/prd/breakdown-plan.md` §6 开放问题 #8 标记为未来 ADR-0001 候选 |
| **（v0.2 更正）** `Job.jd` 非空（READ 一定先产出它）；`jobs.ledger`/`jobs.fit` 在 **DB 层可空**，但**必须一起写入**——CROSS+SCORE 在同一次请求内原子完成，不允许"有 ledger 无 fit"的中间态被持久化。FND-04 的 Zod `Job`（三字段皆必填）不变，它是**完整 Job 的 API 契约**：行可以在 FIT-01 与 FIT-02 之间短暂不完整，但 API 只在 FIT-02 完成后才返回完整 `Job`。DB 侧契约是 `lib/db/queries/jobs.ts` 的 `PersistedJob`（`ledger`/`fit` 可空） | §5.6 `Job` schema 三字段均非 nullable（Zod 侧保持不变）；本条原文假设"建行即原子"，与本模块自己的三张票据矛盾——FIT-02 的路由是 `POST /api/jobs/[id]/fit`（路径含 job id ⇒ 行必须已存在）、FIT-03 Deliverable 7 明确渲染"Generating your Fit Report…"中间态。更正依据与被否决的备选见 `docs/plans/FIT-01.md` §0.1，迁移 `0003_perpetual_sunset_bain.sql` |
| SCORE 是纯代码函数，不发起模型调用，不产生独立的 `usage_events` 行（其成本归入 CROSS 那一次 `cross` op 记账） | §5.1 SCORE 行"纯代码"；§5.1 CROSS 行"模型不输出分数" |
| Job 状态机新增的通用 PATCH 路由（`applied`/`interviewing` 转换）放在本模块（FIT-01），不放在触发这些转换的功能模块（`05-tailor`/`06-prep`）里 | Job 实体的持久化层由本模块拥有（§5.6）；`05-tailor` 先于 `06-prep` 交付但两者都需要状态转换路由——放在更早交付的 `04-fit` 避免后建的模块反向依赖先建的模块 |
| `applied` 状态由 `05-tailor`/TLR-02 提供一个手动"标记为已投递"按钮触发，作为保守默认；`closed` 状态 v1 不提供任何触发 UI | PRD 只明确定义了 `interviewing` 的触发方式（§5.4"用户点击'我拿到面试了'"），未定义 `applied`/`closed`——本模块新发现的开放问题，见下表 |
| **（v0.3 新增，FIT-02/D7）** `job.fit` 已存在 ⇒ `POST /api/jobs/[id]/fit` 返回 409 `already_fitted`，在任何付费调用之前；v1 不支持重跑 Fit（重跑 = 新建 job，另计一次 `fit` 配额） | 配额只在建 job 时扣一次（本表第 1 行），无此闸门则一次扣费可无限次付费调用 CROSS——既是成本事件，也是对全体用户的拒绝服务（全局熔断被单个用户打穿）。被否决的备选：返回 200 + 现有 job（静默 no-op 违反 PRD"宁可暴露不完整，不静默吞掉"，且对 FIT-03 隐藏冲突）、`?force=true`（攻击者自己加参数即可绕过）。已知残留：两个并发请求仍可能都读到 `fit === null` 并各付一次费（约 1 次多余调用/job），与 FND-06 已接受的配额竞态同构，收口需要 claim 列或 advisory lock（FND-05 file-scope，需 Horace 决策） |

## 拒绝的备选方案

- **READ 和 CROSS 合并成一次 LLM 调用**：拒绝——PRD §5.1 明确把两者列为独立 stage，各有独立失败策略（都是"JSON 修复重试 1 次 → 报错"，但输入输出边界不同：READ 只读 JD，CROSS 读 JD×Library）；合并会让"窄 schema 分阶段输出质量显著优于单次大 prompt"（§5.1 开篇原则）失效，且违反"客户端按操作发起 1–3 次独立 API 调用"的既定架构。
- **SCORE 权重立即按用户反馈可调**：拒绝——PRD §13 Q1"没有 ground truth 时调参数是迷信"，v1 固定用朴素映射，可调性是 V1.1 触发式功能。

## 开放问题

| # | 问题 | Owner |
|---|---|---|
| 1 | `applied`/`closed` 状态的触发方式未在 PRD 中定义 | Horace（product）——v1 默认：`applied` 由 TLR-02 提供手动按钮；`closed` 不提供 UI（枚举值存在但不可达），需 Horace 确认或改设计 |
| 2 | READ+CROSS+SCORE 视为单一原子"Fit"操作、配额在 READ 时一次性扣减——硬到不可逆的架构选择 | Horace（product）+ 建议固化为未来 ADR-0001（继承自 `docs/prd/breakdown-plan.md` §6 #8） |
| 3 | RESEARCH 是否前移到 Fit 阶段（PRD §13 Q3） | Horace（product）——v1 明确不做，只记录 |
| 4 | READ/CROSS 的调好 prompts（附录A"已调通，claude-sonnet-4-6 基线"）不在本仓库 | Horace（product）——FIT-01/FIT-02 在此问题解决前默认从零按 §5.1 规则编写 prompt |
| 5 | **（v0.3 新增）** rerun 的产品形态与配额语义：D7 落地为 409 `already_fitted`，但 PRD 自己的 layer-2 标记就写着"uncovered — **rerun**"，即 PRD 暗示的这个 affordance 在 v1 除了"新建一个 job"之外没有实现 | Horace（product）——可选方案：每 job 的重跑计数、重跑另扣一次 `fit` 配额、或仅管理员可重跑 |

## 工作分解

| 票据 | 标题 | Size | Lane | 主要文件范围 | 依赖 |
|---|---|---|---|---|---|
| FIT-01 | Job 创建（READ）+ 状态流转路由 + 无库门控 | M | 04-fit | `app/api/jobs/route.ts`, `app/api/jobs/[id]/route.ts`, `lib/db/queries/jobs.ts` | FND-03, FND-04, FND-05, FND-06, FND-08, FND-10, LIB-02, EVL-02 |
| FIT-02 | CROSS + SCORE 路由 | L | 04-fit | `app/api/jobs/[id]/fit/route.ts`, `lib/scoring/**` | FIT-01, FND-07, EVL-02 |
| FIT-03 | Jobs 列表 + Job 详情壳（三段 tab）+ Fit Report 页 | M | 04-fit | `app/(app)/jobs/page.tsx`, `app/(app)/jobs/[id]/layout.tsx`, `app/(app)/jobs/[id]/page.tsx`, `app/(app)/jobs/[id]/_components/**` | FIT-02 |

## 模块级验收

- [ ] `[fixture]` `pnpm eval` 对 `02-evaluation`/EVL-01 的 10 份 JD fixture 跑 Q1 全绿（schema 通过率 100%、requirement 覆盖恰好一次、dropped < 15%）（PRD §10 P2 "Q1 全绿"）。
- [ ] `[fixture]` `pnpm eval` 的 Q2 接地断言对 CROSS 产出的 bindings/evidence ≥ 95% 通过（PRD §10 P2 "Q2 接地 ≥ 95%"）。
- [ ] `[machine]` 无库用户调用 `POST /api/jobs` 返回明确的门控错误，而非 500 或静默创建（PRD §5.7"无库时禁止新建 job"）。
- [ ] `[machine]` SCORE 的综合分/档位计算是 `Ledger` 的纯函数，同一 `Ledger` 输入永远产出同一输出（确定性测试）。

## Changelog

- v0.3（2026-07-23，FIT-02 Builder 回写）：**决策表新增 1 行**（FIT-02/D7 的 `already_fitted` 重跑闸门），**开放问题新增 #5**（rerun 的产品形态与配额语义）。D7 是本模块决策表第 1 行"配额在 READ 发生前扣减一次覆盖整个 Fit 操作"的**执行半边**：没有它，那条决策在成本上不成立。未来的 ADR-0001（开放问题 #2）落笔时必须把这个闸门写进去——移除闸门＝静默重开无限付费重放。其余决策、拒绝的备选、开放问题 #1–#4 状态不变。实现与被否决备选的完整记录见 `docs/plans/FIT-02.md` §0.1 与 FIT-02 票据 Changelog v0.1。
- v0.2（2026-07-23，FIT-01 Builder 回写）：**更正决策表第 2 行**（原文："`Job.jd`/`ledger`/`fit` 三字段非空……CROSS+SCORE 必须在同一次请求内原子完成"）。该行是本模块三张票据中唯一假设"建行与 CROSS+SCORE 原子完成"的产物，与 FIT-01/FIT-02/FIT-03 的既定路由形状互相矛盾（FIT-02 是 `POST /api/jobs/[id]/fit`，路径含 job id；FIT-03 Deliverable 7 明确渲染中间态）。现更正为：`jd` 非空；`ledger`/`fit` DB 可空但必须**一起**写入（"原子"约束从"建行时"移到"CROSS+SCORE 的那一次写入内"，由 `lib/db/queries/jobs.ts` 的 `attachLedgerAndFit` 单条语句保证，DB 不做约束）；FND-04 的 Zod `Job` 不变，仍是完整 Job 的 API 契约。对应迁移 `0003_perpetual_sunset_bain.sql`，上游回写见 `01-foundation/README.md` v0.7、FND-04 票据 v0.2、FND-05 票据 v0.2。**决策权在 Horace：合并 FIT-01 即为签字；若否决，则 FIT-01/02/03 需按 `docs/plans/FIT-01.md` §0.1 的 R-B 重新拆票。** 开放问题 #1/#2/#4 状态不变（仍开放）。
- v0.1（2026-07-17）：初稿，随 `/breakdown-prd` 生成。
