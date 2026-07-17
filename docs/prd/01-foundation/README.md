# 01-foundation — Sub-PRD

| | |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-07-17 |
| 上游 | [docs/PRD.md](../../PRD.md) §8, §5.5, §5.6, §10 P0 |
| 状态 | Draft → Gate 1 评审 |

## 问题

除本模块外的每个下游模块都需要同一套：数据契约（Zod）、持久化 schema（Drizzle/Postgres）、模型与价格/配额配置、服务端四层校验、鉴权与会话、可部署的应用骨架。如果这些各自在功能模块里首次出现时才补建，会导致契约在多处漂移、referential integrity 校验各写一份、配额数字各配各的。PRD §8.2 架构图把这些明确列为独立于 `/api/parse · /api/read · /api/cross(+score) · /api/tailor · /api/research · /api/rehearse` 之外的公共层——"Zod v4 边界 + referential / number integrity + 配额检查 + usage_events 记账"和"Drizzle ORM ──► Neon Postgres"都画在所有 stage 路由之下。

## 范围 / Non-goals

**范围**：PRD §10 P0 行定义的交付物——"repo、Auth.js、Drizzle schema、Vercel 部署流水线"，加上供 P1–P5 复用的四类共享基础设施（schema、config、validation、usage 记账）。

**Non-goals**：

- 不实现任何 pipeline stage（PARSE/READ/CROSS/…）——那是 `03-library` 起的功能模块的范围。
- 不实现 `pnpm eval`（Q1–Q3 harness）——那是 `02-evaluation` 的范围；本模块只提供 `pnpm test`（机器可跑的标准测试套件命令）。
- 不实现邀请码——PRD §9 提到但 `07-platform-launch`/PLT-04 才是实现处；本模块的 Auth.js 配置对邀请码留一个可扩展的 `signIn` callback 挂点，不在此内置校验逻辑。
- 不创建实际的 Vercel 项目、不配置真实环境变量、不绑定域名——这些需要 Horace 的账号权限，agent 无法执行（见 FND-09 的 Feedback obligation）。

## 决策

| 决策 | 依据（PRD §） |
|---|---|
| Zod schema 按"简单实体（Project/Library/Profile/Resume）"与"pipeline 阶段负载（JdExtract/Ledger/FitReport/Alignment/Edit/Intel/Rehearse）"拆成两个独立文件/票据，互不 import，都只依赖 FND-01 | §5.6 给出的代码块里 Job/TailoredResume/Brief 直接嵌入 JdExtract/Ledger/FitReport/Alignment/Edit/Intel/Rehearse 字段，但 Project/Library/Resume 与这些阶段负载类型之间没有嵌入关系，只有字符串级 id 引用——拆分不产生循环依赖 |
| "持久化实体"（Job/TailoredResume/Brief/UsageEvent/EvalRun）单独一张票，晚于两个基础 schema 票 | §5.6：`Job` 直接内嵌 `JdExtract`/`Ledger`/`FitReport`；`TailoredResume` 内嵌 `Alignment`/`Edit`；`Brief` 内嵌 `Intel`/`Rehearse` |
| `EvalRun` 的 Zod schema 与 `UsageEvent` 一起在本模块定义，即使其精确字段 PRD 未给出 | §6 "报告落 `eval_runs`"；§5.6 的 Postgres 表清单已列出 `eval_runs`，但没有给字段级 schema——按 PRD 文首声明"字段级 schema…随实现以 feature spec 落定"（PRD 表头一行），本模块据此先给出最小可用形状：`{ id, suite: 'q1'\|'q2'\|'q3', op, passRate, details, createdAt }`，供 `02-evaluation` 消费 |
| PARSE（建库）不设每日配额 | §8.3 明确只列出"per-user 每日 10 fit / 5 tailor / 3 prep"三个配额桶，未提 parse——本模块的配额 config 因此只暴露 `fit`/`tailor`/`prep` 三个 op key，不为 `parse` 发明一个配额，避免下游模块（`03-library`）误加 |
| 配额与全局熔断都用 Postgres 计数器（对 `usage_events` 表做时间窗口 `COUNT`/`SUM`），不建独立计数器表 | §8.1 "配额用 Postgres 计数器"；§8.4 "不上 APM——一张表加一页汇总就是这个量级 observability 的全部" |
| Auth.js 使用 Drizzle adapter，`users` 表由 Auth.js 官方 schema 决定基本形状，本模块据此建表 | §8.1 "选 Auth.js 而非 Clerk：无 per-MAU 供应商依赖，Drizzle adapter 成熟" |
| `pnpm test`（本模块创建）与 `pnpm eval`（`02-evaluation`/EVL-02 创建）是两条不同命令，不合并 | PRD §6 "前三道进 CI 习惯（`pnpm eval`…）"明确点名 `pnpm eval` 是质量门命令；本仓库 `templates/ticket.template.md` 另外要求"project test-suite command"作为验收标配项——两者服务不同目的（单元/集成正确性 vs. LLM 输出质量），合并会让"suite green"这个验收项和"Q1–Q3 通过"这个验收项无法分别断言 |

## 拒绝的备选方案

- **向量库/RAG 存 Library**：PRD §3"v1 不做"表与 §8.1 显式排除，"单用户库 < 50 条全量进 context；Zod 边界 + 裸 fetch 足够"——不建，任何模块都不得引入。
- **Redis 做配额计数**：§8.1 显式排除，"配额用 Postgres 计数器"。
- **把 Zod schema 按 stage 逐个拆成 7 张票（PARSE/READ/CROSS/SCORE/TAILOR/RESEARCH/REHEARSE 各一张）**：拒绝——SCORE 不产生新类型（`FitReport` 已在 CROSS 所属的负载 schema 票里），且逐 stage 拆分会让"两张票都改同一个文件"的情况在基础设施阶段就出现，违反 disjoint file-scope 的初衷；改为按"简单实体 / 阶段负载 / 持久化实体"三层拆分，层内边界即文件边界。

## 开放问题

| # | 问题 | Owner |
|---|---|---|
| 1 | 产品名与域名最终确认（PRD §13 Q4） | Horace（product） |
| 2 | Vercel 项目创建、真实环境变量（`ANTHROPIC_API_KEY`/`DATABASE_URL`/`AUTH_SECRET`/`GOOGLE_CLIENT_ID`&`SECRET`/`RESEND_API_KEY`）配置、域名绑定，agent 无权限执行 | Horace（product/infra） |
| 3 | `EvalRun` 的字段级 schema 是本模块的推断产物（PRD 未给出），需 `02-evaluation` 落地时确认是否够用 | Horace（product），若 `02-evaluation` 发现不够用则由 EVL-02 直接改本模块的 schema 文件并在其 Feedback obligation 里写回 |

## 工作分解

| 票据 | 标题 | Size | Lane | 主要文件范围 | 依赖 |
|---|---|---|---|---|---|
| FND-01 | Repo 与工具链引导 | S | 01-foundation | `package.json` 等根配置、`.github/workflows/ci.yml`、`tests/` | — |
| FND-02 | 核心简单实体 Zod schema | S | 01-foundation | `lib/schemas/entities.ts` | FND-01 |
| FND-03 | Pipeline 阶段负载 Zod schema | M | 01-foundation | `lib/schemas/pipeline.ts` | FND-01 |
| FND-04 | 持久化实体 Zod schema | S | 01-foundation | `lib/schemas/persisted.ts` | FND-03 |
| FND-05 | Drizzle schema + Neon 客户端 + 迁移 | M | 01-foundation | `db/**` | FND-02, FND-04 |
| FND-06 | 模型/价格/配额 config + 配额与熔断函数 | M | 01-foundation | `lib/config/**` | FND-01, FND-05 |
| FND-07 | 服务端四层校验工具 | M | 01-foundation | `lib/validation/**` | FND-02, FND-03 |
| FND-08 | Auth.js v5（Google OAuth + magic link）+ session 工具 | M | 01-foundation | `auth.ts`, `middleware.ts`, `lib/auth/**`, `app/api/auth/**` | FND-05 |
| FND-09 | App shell + Vercel 部署骨架 + CI | S | 01-foundation | `app/layout.tsx`, `app/page.tsx`, `app/(auth)/signin/page.tsx`, `vercel.json` | FND-01, FND-08 |
| FND-10 | usage/cost 记账工具 | S | 01-foundation | `lib/usage/record.ts` | FND-05, FND-06 |

## 模块级验收

- [ ] `[machine]` `pnpm install && pnpm build` 在干净 checkout 上成功。
- [ ] `[machine]` `pnpm test` 命令存在且全绿（FND-01 创建，此后所有票据的新增测试都汇入这条命令）。
- [ ] `[machine]` 任一下游模块的 API 路由可以 `import` 本模块导出的 schema/config/validation/usage/session 符号而不需要重复定义。
- [ ] `[human]` Horace 确认 Vercel 项目已创建、环境变量已配置、`GET /` 在公网可访问（P0 "空应用在线"的人工验收部分，FND-09 的 Feedback obligation 触发此项）。

## Changelog

- v0.1（2026-07-17）：初稿，随 `/breakdown-prd` 生成。
