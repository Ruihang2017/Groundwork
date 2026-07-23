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
