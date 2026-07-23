# 01-foundation — Sub-PRD

| | |
|---|---|
| 版本 | v0.7 |
| 日期 | 2026-07-23 |
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

- v0.7（2026-07-23）：**跨模块回写：`04-fit`/FIT-01 修改了本模块拥有的 `db/**`**（FND-05 Feedback obligation #1 + FND-04 Feedback obligation #2 双双触发，详见 FND-04 票据 Changelog v0.2、FND-05 票据 Changelog v0.2、`docs/plans/FIT-01.md` §0.1）。要点：(1) **`jobs.ledger` / `jobs.fit` 由 `NOT NULL` 改为 DB 可空**（`jobs.jd` 不变，仍 `NOT NULL`），迁移 `0003_perpetual_sunset_bain.sql` 由 `pnpm db:generate` 生成、未手改，内容仅两条 `ALTER TABLE "jobs" ALTER COLUMN ... DROP NOT NULL`。(2) **`lib/schemas/persisted.ts` 的 Zod `Job` 不变**——它仍是"完整 Job 的 API 契约"（三字段皆必填）；DB 侧契约是 `lib/db/queries/jobs.ts` 里模块本地的 `PersistedJob`（`ledger`/`fit` 可空）。**持久化契约弱于 API 契约，是有意为之**：行可以短暂不完整，返回给客户端的 `Job` 不可以。(3) **原因**：Fit 是"一次用户操作、两次服务端调用"——FIT-01 的 `POST /api/jobs` 只凭 READ 输出建行，FIT-02 的路由是 `POST /api/jobs/[id]/fit`（路径里有 job id ⇒ 行必须已存在），FIT-03 Deliverable 7 还明确要渲染这个中间态。原先 FND-04/FND-05 假设的"原子建行"与 `04-fit` 自己的三张票据互相矛盾（`04-fit/README.md` 决策 row 2 已随之更正，见该文件 v0.2）。(4) **同一 commit 内更新了两处上游测试**：`db/schema.test.ts` 的 NOT NULL 断言翻转；`db/migrate.test.ts` 的 Tier-2 断言重写——它 grep 的是**所有迁移文件的拼接**，旧正则仍能匹配 `0000`，会**在断言一个已不成立的事实的同时保持绿色**，现改为断言迁移链的终态；Tier-3 往返测试改为证明"只带 `jd` 的插入成功、缺 `jd` 的插入仍被拒"。(5) **已知的过期消费方，故意不在 FIT-01 内修**：`lib/db/queries/admin.ts:333–340` 的 `fitToTailor` 分母仍统计全部 job，其注释"jobs.fit is NOT NULL"已失效——属 `07-platform-launch` 的 file-scope，作为后续 issue 交给 Horace（`docs/plans/FIT-01.md` §5 Q2）。**决策权在 Horace：合并 FIT-01 即为签字。** 全套测试离线绿（57 files / 649 tests），`pnpm build`（`DATABASE_URL` 未设）exit 0。
- v0.6（2026-07-18）：FND-09 回写——App shell + 登录页 + Vercel 部署骨架 + CI deploy step 落地（`app/layout.tsx`/`app/page.tsx`/`app/(auth)/signin/page.tsx`/`app/(app)/home/page.tsx`/`.github/scripts/deploy-vercel.mjs`/`.github/workflows/ci.yml` append）。要点/偏差（详见 FND-09 票据 Changelog v0.1）：(1) **路由文件偏差 `/home` 而非字面 `app/(app)/page.tsx`**：route group 不产生 URL 段，`app/(app)/page.tsx` 与公开落地页 `app/page.tsx` 同解析为 `/`，`next build` 会以 Next 的 "two parallel pages resolve to the same path"（E28）失败——故置于 `app/(app)/home/page.tsx`（→ `/home`）。已由真实 `pnpm build` 证实（路由表显示 `ƒ /`、`ƒ /home`、`ƒ /signin`，无冲突）。(2) **登录页用 `next-auth/react` 的客户端 `signIn`，非 `@/auth` 的**：`@/auth` 的 `signIn`/`signOut` 在模块顶层 import `next/headers`，无法进入 `'use client'` 文件（会破坏 `next build`）；`next-auth/react` 是 Auth.js 官方客户端组件 API。登出控件仍用 `@/auth` 的 `signOut`（内联 Server Action，`app/layout.tsx` 保持 Server Component 以 `auth()` 服务端取态）——两套 API 各司其职，由 Client/Server 边界强制，非风格不一致。(3) **不建 `vercel.json`**：Next.js 零配置足够（Edge middleware 已干净构建；neon-http 为 HTTP/fetch driver，无连接池模式需配），符合票据"无聊技术栈"偏好，按票据自身许可作为偏差记录。(4) **新增开发依赖**：`@vitejs/plugin-react@5.2.0`（非 6.x——6.x 需 vite ^8，与 vitest 3.2.7 绑定的 vite 7 不兼容）、`@testing-library/react@16.3.2`、`@testing-library/dom@10.4.1`（v16 的必需 peer，票据 dep 清单未列，必要补充）、`jsdom@26.1.0`（非最新 29.x——29/27+ 经 `html-encoding-sniffer@6` → `@exodus/bytes` 为 ESM-only，在 Node 22.11 下 `require()` 崩溃；26.1.0 是最后一个用 CommonJS 安全的 `html-encoding-sniffer@4` 的版本），均精确 pin。`vitest.config.ts` 加 `@vitejs/plugin-react` 插件并将 `test.include` 扩至 `'app/**/*.test.{ts,tsx}'`（本仓库首个 `.tsx` 测试）。(5) **Vercel CLI pin `56.3.1`**（`deploy-vercel.mjs`，`npm view vercel version` 核实）。(6) **CI deploy step 优雅 no-op**：`VERCEL_TOKEN` 缺失时 exit 0 + 打印跳过日志（`tests/deploy-vercel.test.ts` 直接 spawn 真脚本断言），另加 `if: main push` 分支门。全部测试离线（238 passed / 21 files），`pnpm build`（`DATABASE_URL` 未设）exit 0。**真实 Vercel 项目创建/环境变量/域名绑定仍是 Horace 的人工验收项（本模块开放问题 #2，P0 "空应用在线" + "注册/登录可用" 的 `[human]` 出口条件），是本票自动化部分完成后唯一的阻塞项。**
- v0.5（2026-07-18）：FND-08 回写——Auth.js v5 鉴权与会话落地（`auth.ts`/`auth.config.ts`/`middleware.ts`/`lib/auth/session.ts`/`app/api/auth/[...nextauth]/route.ts`，`db/schema.ts` 追加 `accounts`/`sessions`/`verification_tokens` 三表 + 第二个迁移 `0001_first_spiral.sql`）。要点/偏差（详见 FND-08 票据 Changelog v0.1）：(1) **版本 pin**：`next-auth@5.0.0-beta.31` + `@auth/drizzle-adapter@1.11.2`，二者同依赖 `@auth/core@0.41.2`，兼容确认；v5 仅在 `beta` dist-tag（`latest` 仍是 v4），故精确 pin 而非浮动 `@beta`。路由处理器约定 `app/api/auth/[...nextauth]/route.ts` 与 `NextAuth()` 导出形状经安装版确认无偏差（Feedback obligation #1 已核对）。(2) **database session 策略需 `callbacks.session` 显式回填 `session.user.id`**（票据正文未提及的关键细节）：否则 `requireUserId()` 对每个真实登录用户都抛 `UnauthorizedError`，而 mock 单测仍假绿——已实现并由 `auth.config.test.ts` 非 mock 直测覆盖（本模块最高风险项）。(3) **`signIn` 歧义厘清**：邀请码挂点实现为具名导出的 `signInCallback`（= `callbacks.signIn`，PLT-04 在此扩展），Deliverable 2 的 `signIn` action 由 `NextAuth()` 标准解构自动产出，无需额外包装。(4) **`package.json` 纳入 file-scope**（票据 File-scope 漏列，实现三 Deliverable 必需；`01-foundation` 本就拥有该文件，无跨模块 append 顾虑）。(5) **`onDelete: 'cascade'`** 加于 `accounts`/`sessions` 的 `userId` 外键（上游 adapter 参考 schema 无 cascade，随 FND-05 既有约定补齐，行为已测）。(6) `vitest.config.ts` `test.include` 追加 `'*.test.ts'` 以发现根级 `middleware.test.ts`/`auth.config.test.ts`（沿 FND-02/FND-05 先例）。(7) `.env.example` 已含全部 Auth/Resend 键（FND-01），核对无改。(8) **Edge-runtime 构建告警**：`pnpm build` 成功（exit 0，`/api/auth/[...nextauth]` 与 Middleware 均编译通过），但对 `jose` 的 `CompressionStream`/`DecompressionStream`（经 `@auth/core` JWT 模块传递引入）发 Edge 不支持告警——属 JWE 代码路径，database session 策略下不触发，为死引用告警而非运行期失败；`middleware.ts` 内留 `runtime: 'nodejs'` 注释兜底。此项须待 Horace 真实 `DATABASE_URL`/OAuth provisioning（`[human]` 验收项）方能完全闭合，与各 FND 票据同属既有 infra hand-off（本模块开放问题 #2，未变）。全部测试离线运行、不假设 live `DATABASE_URL`/真实 OAuth 凭据。
- v0.4（2026-07-18）：FND-05 回写——`db/**`（Drizzle schema + Neon 客户端 + 初始迁移）落地。三项决策/偏差记录如下（详见 FND-05 票据 Changelog v0.1）：(1) **时间戳列统一用 `bigint` epoch-ms，不用原生 `timestamp`**（唯一例外 `users.emailVerified` 依 Auth.js adapter 的 `Date` 契约）——与 FND-02/FND-04 每个 Zod schema 的 `z.number()` 时间字段 1:1 对应、零转换层。这是**全仓库层面的既定约定**，下游每张 Drizzle 表（FND-08、PLT-04）与每个 query helper 直接继承，无需重新决定；若日后要改回原生 timestamp，需迁移每行数据并改每处调用点（触发 ADR）。(2) **本地 Postgres 测试替身用 PGlite，不用 pg-mem**：票据点名的 `pg-mem` 与 `drizzle-orm` 的 node-postgres driver 根本不兼容（拒绝 drizzle 的 `getTypeParser` 与 `rowMode: 'array'`）；改用 `@electric-sql/pglite`（编译为 WASM 的真实 Postgres）+ 一等的 `drizzle-orm/pglite` driver/migrator——严格更强的替身（用生产同款 migrator 跑已提交的迁移，并经类型化 query builder 往返真实行）。故 Test-plan item 4 的降级路径（只做静态 SQL 检查）**未被采用**，完整往返覆盖已交付。**下游 FND-06 / FND-10 请复用 `@electric-sql/pglite` + `drizzle-orm/pglite`，而非 pg-mem**，作为本地 Postgres 替身。(3) 将 `vitest.config.ts` 的 `test.include` 扩至含 `'db/**/*.test.ts'`（与 FND-02 为 `lib/**` 做的回写同一先例），否则 `pnpm test` 会假绿（跑 0 条本票断言）。此外，真实 Neon `DATABASE_URL` 的 provisioning 仍是 Horace 的人工验收项（本模块开放问题 #2，未变），本票所有测试均离线运行、不假设 live `DATABASE_URL`。
- v0.3（2026-07-18）：FND-02 回写——`lib/schemas/entities.ts`（`Profile`/`Project`/`Library`/`Resume` 及推断类型）落地时，将 `vitest.config.ts` 的 `test.include` 从 `['tests/**/*.test.ts']` 扩至含 `'lib/**/*.test.ts'`：FND-01 继承的 glob 不覆盖本票据自指定的测试文件路径 `lib/schemas/entities.test.ts`，否则 `pnpm test` 会假绿（跑 0 条本票断言）。此改动同时为 FND-03/04/06/07/10 的 colocated `lib/**` 测试文件解锁，无需各自再改此共享配置。详见 FND-02 票据 Changelog v0.2。
- v0.2（2026-07-18）：FND-01 回写（Feedback-obligation #1）——修正**本地**工具链 provisioning。参考开发环境（Node `22.11.0` / Corepack `0.29.4`）上，计划中的 `corepack enable && pnpm install` 会以 `Error: Cannot find matching keyid` 失败：Corepack 内置的 npm registry 签名密钥早于 registry 的密钥轮换，无法验证 pinned 的 `pnpm@10.34.5`。本地正确做法二选一：(a) 使用更新的 Node/Corepack（其内置密钥含轮换后的密钥集），或 (b) 旁路 Corepack 直接装 standalone pnpm——`npm install -g pnpm@10.34.5`，或一次性设 `COREPACK_INTEGRITY_KEYS=0`。**CI 不受影响**：`.github/workflows/ci.yml` 用 `pnpm/action-setup@v4` provision pnpm，它直接下发 pnpm 二进制、从不经 Corepack，故 scaffold（`package.json` pin、lockfile、`ci.yml`）本身正确、无需改动，只欠这条文档回写。回归测试见 `tests/toolchain.test.ts`；对应改动记于 FND-01 票据 Changelog v0.2。
- v0.1（2026-07-17）：初稿，随 `/breakdown-prd` 生成。
