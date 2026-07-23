# 06-prep — Sub-PRD

| | |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-07-17 |
| 上游 | [docs/PRD.md](../../PRD.md) §3 C4, §4 S4, §5.1 RESEARCH/REHEARSE, §5.4, §5.7, §10 P4, §13 Q3 |
| 状态 | Draft → Gate 1 评审 |

## 问题

PRD §1 F3（面试准备通用化）："市面 AI 面试工具只吃 JD 单一输入，输出必然是任何候选人都适用的题库…面试是在 gap 上被决定的，不是在强项上。" 本模块是漏斗最后一步（S4 面），也是 P4（付费成本最高的阶段）的门控实现——PRD §2 P4："成本沿漏斗递增…重操作（web 搜索、面试简报）只在用户显式进入下一阶段时发生。"

## 范围 / Non-goals

**范围**：PRD §3 C4——RESEARCH（公司情报，best-effort）+ REHEARSE（预测问题 + askThem + positioning）+ `interviewing` 状态门控 UI + 简报页。

**Non-goals**：

- 不做 Fit/Tailor 的任何内容——`04-fit`/`05-tailor`。本模块与 `05-tailor` 互相没有依赖，可在 `04-fit` 合并后并行推进（见 `docs/prd/breakdown-plan.md` §4）。
- 不做语音 mock 面试——PRD §11 V1.4，触发条件"V1.1 命中率 ≥ 50%"未达。
- 不做面后回填/命中率闭环——PRD §11 V1.1，触发条件"累计 ≥ 10 场真实面试"未达。
- 不做 RESEARCH 前移到 Fit 阶段——PRD §13 Q3 明确"与 P4 冲突需数据裁决"，v1 不做，仅记录。
- 不新建 Job 状态转换路由——复用 `04-fit`/FIT-01 已建的通用 PATCH 路由。

## 决策

| 决策 | 依据（PRD §） |
|---|---|
| RESEARCH 与 REHEARSE 是两次独立的客户端调用（不是一次），中间态（RESEARCH 已完成、REHEARSE 未开始）不持久化——`Intel` 由客户端持有并作为 REHEARSE 调用的输入，`Brief` 只在 REHEARSE 完成时一次性写入（`intel` + `rehearse` 一起） | §5.6 `Brief.rehearse` 非空、`Brief.intel` 可空——两者只在同一次写入中共同确定；§5.1 RESEARCH/REHEARSE 是独立 stage 行，各自独立失败策略（RESEARCH 降级、REHEARSE 报错），意味着两次调用之间必须有边界，但边界不必是数据库持久化点 |
| `prep` 配额（PRD §8.3"3 prep"/天）在 RESEARCH 调用发起前扣减一次，覆盖 RESEARCH+REHEARSE 整个"生成简报"操作 | §8.3 只列一个 `prep` 配额桶（不是 research+rehearse 两个）；§4 S4"生成简报（公司情报 + ledger + 预测问题与追问）"描述为单一动作。**与 `04-fit` 的 Fit 配额设计同属一类硬到不可逆的架构选择**，见 `docs/prd/breakdown-plan.md` §6 开放问题 #8 |
| RESEARCH 失败时返回 `intel: null` + `fail: true` 标记，REHEARSE 正常继续（不因 RESEARCH 失败而拒绝执行） | §2 P3"Degrade, don't block"；§5.1 RESEARCH 行失败策略"失败标记 fail，简报照常" |
| Prep tab 的锁定/解锁 UI 与"我拿到面试了"触发按钮放在本模块（`app/(app)/jobs/[id]/prep/page.tsx`），不放在 `04-fit`/FIT-03 的共享 layout 里 | `docs/prd/breakdown-plan.md` §3 file-scope 分配：layout 壳由 FIT-03 建，`05`/`06` 只在子路由新增页面；§5.4"解锁条件…用户点击'我拿到面试了'"没有指定按钮位置，本模块选择放在用户实际撞锁的页面上，零跨模块文件改动 |
| （PRP-01 实现）RESEARCH 路由在扣配额与付费调用**之前**加两道服务端漏斗门（票据 Deliverable 2 未列，属新增）：`job.status !== 'interviewing'` → 403 `not_interviewing`；`ledger`/`fit` 为空 → 409 `fit_not_ready`。两道门都在花钱之前 | §5.4"解锁条件 `status = interviewing`" + §2 P4"重操作（web 搜索）只在用户显式进入下一阶段时发生"——现在 Prep 两次调用（RESEARCH/REHEARSE）都服务端强制此门；否则最贵的一半（唯一花真钱搜网的调用）反而无门。合并本票即批准这两道门，放宽是产品决策（见 PRP-01 plan §5 Q6），非 Builder 静默改动 |
| （PRP-01 实现）RESEARCH 只接收 `job.company` + `job.role`，绝不发送 `jdRaw`/`jd`/`ledger`/`Library`/简历 | §5.1 RESEARCH 行输入即"company + role"；**安全理由优先**：这是全 app 唯一挂 `web_search` 工具的调用，任何入 context 的数据都可能进入发往第三方搜索引擎的查询，越出 §8.3"第三方处理方仅 Anthropic API"的边界 |
| （PRP-02 实现，D5）持久化的 `Brief.rehearse` 可以少于 5 个 question：§5.5 layer 1 会丢弃 `projectId` 不在库中的问题（Deliverable 3f + 验收项 5"从持久化中移除并计数"），而 FND-03 的 `Rehearse.questions` 是 `.length(5)`。本票在 `lib/db/queries/briefs.ts` 内**模块本地**放松（`PersistedRehearse`/`PersistedBrief`，仅放松 questions 长度为 `.max(5)`），严格 `.length(5)` 仅用于路由的模型输出预解析。**这是硬到不可逆的 schema/产品选择**，durable fix（改 FND-03，或改成对幻觉 projectId 直接 422 而非丢弃-持久化）属 Horace + 01-foundation，并牵动 EVL-02 的 `assertQ1Questions`（< 5 即 fail）与 PRP-04 读路径——建议固化为 **ADR-A** | §5.5 layer 1"dropped 从 questions 移除"；FND-03 `Rehearse.length(5)` 与 FND-04 `Brief.rehearse` 非空；`breakdown-plan.md` §3"任何模块新增的 Zod 类型必须落在自己模块目录下" |
| （PRP-02 实现，D3/D2）REHEARSE 路由新增两处：409 `no_library`（库为空则 layer 1 会丢光全部问题、prompt 也无 id 可引，与 FIT-02 同——防御纵深，`getLibrary` throw 则是 500 而非 no_library）；200 响应体在持久化的 `Brief` 之外附加 `dropped: { count, questions }` 透明性信封（`Cache-Control: no-store`） | §5.5 layer 1"dropped 计数随响应返回，前端可查看被弃原始条目（透明性）"；票据 Deliverable 3i 只说"返回 Brief"，此为有依据的扩展。`Brief.parse()` 会无害地剥掉附加键 |
| （PRP-02 实现，D4/D13）REHEARSE 失败策略是**严格**的（与 RESEARCH 降级相反）：一次 JSON 修复后仍不可用 → 422 `rehearse_failed`，绝不降级为 200/null（`Brief.rehearse` 非空，无法持久化"半个"简报）。`upsertBrief` 覆盖写（每 job 一个 Brief，无 `already_rehearsed` 门），继承 TLR-01 的 re-run 语义——但**成本不对称**：本路由每次调用不扣费（`prep` 已在 PRP-01 扣过），无门覆盖写 = 单个 `prep` 单位可无限次付费 REHEARSE，仅靠全局熔断 + PRP-03/PRP-04 单飞约束兜底。票据明确要求覆盖写，故不静默加门，升级 Horace（见 open question #3） | §5.1 REHEARSE 行失败策略"同上"（= READ/CROSS"JSON 修复重试 1 次 → 报错"）；票据 Deliverable 2"overwrite semantics matching TLR-01" |
| （PRP-04 实现，D2）UI 编排 = RESEARCH 先、REHEARSE 后，降级与硬失败**分道**：RESEARCH 返回 **200**（无论 `failed:false/true`，甚至 200 体解析失败）→ 捕获 `intel`（`Intel` 或 `null`）并继续 REHEARSE；RESEARCH **非 200** → 停下报错、**不**调 REHEARSE | §2 P3"降级不阻断"只覆盖 200/`failed:true`；非 200 是另一回事：REHEARSE 不扣费（`prep` 在 RESEARCH 时已扣），若 RESEARCH `429` 后仍调 REHEARSE 会为无配额用户生成一份付费简报、绕过唯一配额门——**成本漏洞**，故非 200 硬停。200 体畸形按降级（`intel:null`）继续，最大化"降级不阻断" |
| （PRP-04 实现，D4）客户端 REHEARSE-200 响应 schema 用**放松的** `rehearse`（`questions: .max(5)`，非严格 FND-03 `Brief.length(5)`）；服务端 reload 路径的 `getBrief` 已返回放松的 `PersistedBrief`，`BriefView` 当数据消费、**不再**按严格 `Brief` 重解析 | 这是 PRP-02 D5 预注册的 **ADR-A** 读路径落地：referential integrity 会合法丢弃幻觉 `projectId` 的问题，故一份**有效**简报可带 0–5 个问题；按严格 `.length(5)` 解析会把一次**成功**的 4-问题生成误判为"无法生成简报"。模块本地由纯 schema 组合（`breakdown-plan.md` §3），不改 FND-03/`briefs.ts` |
| （PRP-04 实现，D1）"生成简报"在 `BriefGenerator` **挂载时自动触发**（每次挂载一次 RESEARCH→REHEARSE 单飞序列），非点击触发。**成本边界**：REHEARSE 成功前不持久化 `Brief`，故持续失败的生成会在每次重新进入解锁 Prep 时**重扣** `prep`（受 3/天 → 429 上限约束），与 `fit-auto-runner` 同一类已知限制 | 验收项 1"on render"+ §5.1 RESEARCH 触发"进入 Prep"；镜像 Fit 自动跑法。dogfood 若显示成本痛点则升级 Horace（见开放问题 #3），**不**静默改点击（会违反"on render"） |
| （PRP-04 实现，D5）REHEARSE 阶段失败后"Try again"**只**重跑 REHEARSE（复用已成功 RESEARCH 捕获的 `intel`）；RESEARCH 阶段失败后"Try again"重跑整个序列 | RESEARCH 扣了 `prep` 且花了真实搜索钱，REHEARSE 免费——因**免费**的后半段失败而重跑 RESEARCH 会白费第二个 `prep` 单位（PRP-02 开放问题 #3 所指浪费） |

## 拒绝的备选方案

- **RESEARCH+REHEARSE 合并成一次 LLM 调用**：拒绝——两者失败策略不同（RESEARCH 降级、REHEARSE 报错），合并会让"降级不阻断"这条规则在实现层面无法表达（一次调用要么全成功要么全失败，无法只让一半降级）。
- **RESEARCH 结果持久化为 Brief 的中间态**：拒绝——`Brief.rehearse` 非空的 schema 约束（FND-04）意味着没有"只有 intel 没有 rehearse"的合法持久态；客户端持有中间结果是唯一不违反 schema 的设计。

## 开放问题

| # | 问题 | Owner |
|---|---|---|
| 1 | RESEARCH 是否前移到 Fit 阶段（PRD §13 Q3） | Horace（product）——v1 明确不做，只记录 |
| 2 | RESEARCH/REHEARSE 的调好 prompts（附录A"已调通，claude-sonnet-4-6 基线"）与 `interview-brief.jsx`（三 tab UI 参考）均不在本仓库 | Horace（product）——PRP-01/PRP-02/PRP-04 在此问题解决前默认从零按 §5.1/§5.4 规则编写 prompt 与 UI，不假设任何路径存在 |
| 3 | RESEARCH+REHEARSE 视为单一原子"Prep"操作、配额在 RESEARCH 时一次性扣减——硬到不可逆的架构选择 | Horace（product）+ 建议固化为未来 ADR-0001（与 `04-fit` 同属一类，继承自 `docs/prd/breakdown-plan.md` §6 #8） |

## 工作分解

| 票据 | 标题 | Size | Lane | 主要文件范围 | 依赖 |
|---|---|---|---|---|---|
| PRP-01 | RESEARCH API 路由 | M | 06-prep | `app/api/jobs/[id]/research/route.ts` | FND-03, FND-06, FND-10, FIT-01 |
| PRP-02 | REHEARSE API 路由 | M | 06-prep | `app/api/jobs/[id]/rehearse/route.ts`, `lib/db/queries/briefs.ts` | PRP-01, FIT-02, FND-07, EVL-02 |
| PRP-03 | Prep tab 壳（锁定/解锁 UI） | S | 06-prep | `app/(app)/jobs/[id]/prep/page.tsx` | FIT-01 |
| PRP-04 | 简报内容 UI | M | 06-prep | `app/(app)/jobs/[id]/prep/page.tsx`（扩展 PRP-03 同文件） | PRP-01, PRP-02, PRP-03, FND-04, FND-05 |

## 模块级验收

- [ ] `[fixture]` `pnpm eval` 的 Q1 断言（questions == 5 且 trap 非空）全绿。
- [ ] `[fixture]` `pnpm eval` 的 Q3 特异断言 ≥ 90%（PRD §10 P4 "Q3 ≥ 90%"）。
- [ ] `[machine]` RESEARCH 调用失败时，REHEARSE 仍能正常产出并持久化 `Brief`（`intel: null`）。
- [ ] `[machine]` `status !== 'interviewing'` 的 job 访问 Prep tab 显示锁定文案，不触发任何 RESEARCH/REHEARSE 调用。
- [ ] `[human]` 一个真实 job 全漏斗（建库→筛→投→面）走通（PRD §10 P4 验收标准），本项由 Horace dogfood 完成，不产生机器可断言的票据。

## Changelog

- v0.1（2026-07-17）：初稿，随 `/breakdown-prd` 生成。
- v0.2（2026-07-23，PRP-01 Builder writeback）：RESEARCH 路由（`app/api/jobs/[id]/research/route.ts` + prompt + test）落地。新增两道服务端漏斗门（403 `not_interviewing` / 409 `fit_not_ready`，见决策表）与 D1 最小输入规则。降级契约（PRD §2 P3）：付费调用及之后的任何失败——含"零搜索/全部搜索报错"——返回 200 `{ intel: null, failed: true }`，绝不 4xx/5xx。空搜索结果数组视为"真搜索但查无实据"（`failed: false`），是本票相对旧分支 `origin/ticket/PRP-01` 的有意分歧。`prep` 配额在此一次性扣减、`op: 'research'` 仅成功时记一行——**PRP-02 不得重复扣 `prep`**。降级路径不记账（全局熔断少计其花费，含付费搜索）为已知缺口，遵 §5 Q4 全仓一致处理，未在此单独改。真实模型 smoke run 未执行（环境无 `ANTHROPIC_API_KEY`），列为 Horace 的 P4 签核阻塞项（见 PRP-01 plan §4 R4）。开放问题 #2/#3 保持不变。
- v0.4（2026-07-24，PRP-04 Builder writeback）：简报内容 UI（本模块最后一票）落地——`prep/page.tsx` 解锁分支扩展 + 六个 Deliverable 组件（`research-fail-banner`/`intel-card`/`question-list`/`ask-them-list`/`positioning-summary`/`dropped-count-header`）+ 四个结构必需但票据 Deliverable 未逐一列出的文件（`brief-view.tsx` 单一组合点、`brief-generator.tsx` RESEARCH→REHEARSE 编排器、`_lib/project-names.ts`、`_fixtures/brief-fixtures.ts`——已在票据 Changelog 显式 flag，全在 `prep/**` 内、零跨模块 import）。载重决策见决策表新增四行：**D2** 编排的降级/硬失败分道（含非 200 RESEARCH 必须硬停的成本漏洞）、**D4** 客户端放松读路径落地 ADR-A（`questions .max(5)`，否则会把成功的少于 5 问题生成误判为失败）、**D1** 挂载自动触发的成本边界、**D5** intel 复用重试。两处已知限制（均为固有、未 workaround）：(1) dropped-count 表头仅在生成时可见、后续访问不可见（`droppedCount` 不在持久化 `Brief` schema，durable fix 属 FND-04/Horace）；(2) `Brief` 持久化前自动触发会跨访问重扣 `prep`（镜像 Fit）。无"重新生成"按钮为票据明定的 scope 边界（Deliverable 7 + Feedback obligation #1）。`corepack pnpm test` **104 文件 / 1239 测试全绿**（基线 95/1195，+9 文件 / +44 测试）；lint clean；`DATABASE_URL` 未设时 build 通过、`/jobs/[id]/prep` 入表；跨模块 import 检查零命中。所有测试均 stub `fetch` + 手写 fixture，只证明接线（调用顺序、降级路由、单飞、放松读、组合渲染），不证明简报真实质量——真实端到端简报是 Horace 的 P4 dogfood `[human]` 验收（票据验收项 7）。**状态行未改**：本票是模块最后一票，但"module 完成"应由 Reviewer CLEAR + 合并后确认，Builder 不提前翻转状态。开放问题 #2/#3 保持不变。
- v0.3（2026-07-24，PRP-02 Builder writeback）：REHEARSE 路由（`app/api/jobs/[id]/rehearse/route.ts` + `lib/rehearse/prompt.ts` + `lib/db/queries/briefs.ts` + 两个 test）落地。载重决策 **D5**：持久化的 `Brief.rehearse` 可少于 5 个 question（§5.5 layer 1 丢弃 + 验收项 5 计数），在 `briefs.ts` 内模块本地放松 `PersistedRehearse`/`PersistedBrief`，严格 `.length(5)` 仅用于模型输出预解析——建议固化为 ADR-A，durable fix 属 FND-03/Horace（见决策表 + 开放问题 #3）。Deliverable 3 的有据扩展：409 `no_library` 门 + 200 附加 `dropped` 透明性信封（D2/D3）。失败策略**严格**（D4）：一次修复后不可用 → 422 `rehearse_failed`，不降级（与 RESEARCH 的 200/null 相反）。覆盖写、无 replay 门（D13），但成本不对称（本路由不扣费，`prep` 已在 PRP-01 扣过）→ 单个 `prep` 可无限次付费 REHEARSE，升级 Horace（open question #3），未静默加门。`QUOTA_OP_TO_USAGE_OP` 复核通过：本路由记 `op: 'rehearse'`（非配额映射 op），**不调用 `checkAndIncrementQuota`**（有测试钉死）。语言跟随 JD（D9）。`pnpm test` 80 文件 / 1087 测试全绿（基线 78/1040，+2 文件/+47 测试）；lint clean；`DATABASE_URL` 未设时 build 通过、路由入表；plan §3 变异检查已执行、四处均非空跑。真实模型 + 真实 judge 的 Q3 特异率跑未执行（环境无 `ANTHROPIC_API_KEY`），列为 Horace 的 P4 签核阻塞项。开放问题 #2/#3 保持不变。
