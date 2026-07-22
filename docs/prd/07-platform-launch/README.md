# 07-platform-launch — Sub-PRD

| | |
|---|---|
| 版本 | v0.5 |
| 日期 | 2026-07-17 |
| 上游 | [docs/PRD.md](../../PRD.md) §3 C5, §8.3, §8.4, §9, §10 P5 |
| 状态 | Draft → Gate 1 评审 |

## 问题

PRD §3 C5（上线基线）："注册登录、用量配额、隐私政策与删号、备份、成本与质量可观测"——这些是"公开上线"这一决策（PRD §8.1 开篇）强制要求的，与任何单一漏斗功能无关，是产品能够合法、安全、可持续地面向公众运行的前提。PRD §12 风险表把"免费用户成本失控"与"简历 PII 泄露"列为前两项风险，本模块是这两项风险的主要缓解落点。

## 范围 / Non-goals

**范围**：PRD §3 C5——隐私政策/ToS 页 + 账号硬删 + 每周备份 + `/admin` 可观测页 + 邀请码控制注册。

**Non-goals**：

- 不做配额检查/全局熔断的核心逻辑——已在 `01-foundation`/FND-06 实现；本模块不重复实现，只在 `/admin` 页读取 `usage_events` 做汇总展示。
- 不做任何功能模块（`03`–`06`）的配额调用接入——那是各功能模块自己的路由职责（FIT-01 调用 fit 配额、TLR-01 调用 tailor 配额、PRP-01 调用 prep 配额），本模块不触碰它们的文件。
- 不做计费/商业化——PRD §3"v1 不做"表："计费 / 商业化 → V2"。
- 不做第三方分析接入——PRD §8.3"v1 不接第三方分析（自建 `usage_events` 足够）"。

## 决策

| 决策 | 依据（PRD §） |
|---|---|
| 账号硬删跨全部 8 张表按 `userId`（或经 `jobs` 表 join）级联删除，不依赖任何表的软删字段 | §5.6 "**删号 = 硬删该用户全部数据**"；§8.3 同文一致 |
| 邀请码存 Postgres 新表 `invite_codes`，不用 env var 静态列表 | §8.1"配额用 Postgres 计数器"体现的"无聊技术栈但用数据库、不用临时方案"倾向；邀请码需要跟踪使用状态（谁用了、何时用），env var 静态列表无法记录使用状态 |
| `/admin` 鉴权用 env var 邮箱白名单 | PRD 未定义管理员鉴权机制（本次拆解新发现的开放问题）；采用与 §9"邀请码控制注册节奏"、§8.3"全局日花费熔断阈值（env）"一致的 env var 风格作为默认，待 Horace 确认 |
| 备份走 GitHub Actions cron + `pg_dump` → Cloudflare R2，不引入额外备份服务 | §8.2 架构图"每周 `pg_dump`（GitHub Actions cron）→ Cloudflare R2" |

## 拒绝的备选方案

- **第三方分析工具（如 Mixpanel/Amplitude）**：拒绝——直接违反 §8.3"v1 不接第三方分析（自建 `usage_events` 足够）"。
- **软删除代替账号硬删**：拒绝——直接违反 §5.6"删号 = 硬删该用户全部数据"的明文要求；这是隐私承诺，不是可协商的实现细节。

## 开放问题

| # | 问题 | Owner |
|---|---|---|
| 1 | `/admin` 页面的管理员鉴权机制未在 PRD 中定义 | Horace（product）——PLT-03 默认实现为 env var 邮箱白名单，需 Horace 确认或改设计 |
| 2 | 产品名与域名最终确认（继承自 `01-foundation/README.md`，影响本模块的 Privacy/ToS 页文案与备份/R2 命名空间） | Horace（product） |
| 3 | Vercel/Neon/Resend/R2 的真实账号与凭据配置（继承自 `01-foundation/README.md`） | Horace（product/infra） |

## 工作分解

| 票据 | 标题 | Size | Lane | 主要文件范围 | 依赖 |
|---|---|---|---|---|---|
| PLT-01 | 隐私政策/ToS 页 + 账号硬删 | M | 07-platform-launch | `app/(legal)/**`, `app/api/account/delete/route.ts`, `app/(app)/settings/page.tsx` | FND-05, FND-08 |
| PLT-02 | 每周备份流水线 | S | 07-platform-launch | `.github/workflows/backup.yml`, `docs/ops/backup.md` | FND-05 |
| PLT-03 | `/admin` 可观测页 | M | 07-platform-launch | `app/(admin)/**`, `lib/db/queries/admin.ts` | FND-10, FND-08 |
| PLT-04 | 邀请码注册门控 | S | 07-platform-launch | `db/schema.ts`（追加）, `auth.ts`（追加）, `app/(auth)/signin/page.tsx`（追加） | FND-05, FND-08 |

本模块与 `03`–`06` 全部功能模块之间没有依赖边，可在 `01-foundation` 合并后立即与它们并行推进（见 `docs/prd/breakdown-plan.md` §4）。

## 模块级验收

- [ ] `[machine]` 账号硬删后，全部 8 张表中该 `userId`（或经 `jobs` join）的行数为 0（PRD §5.6/§8.3 "删号 = 硬删该用户全部数据"的直接断言）。
- [ ] `[machine]` `/admin` 页汇总周成本、p50/p95 延迟、dropped 率、漏斗转化，数据源全部来自 `usage_events`，不接任何第三方分析 SDK（PRD §8.4）。
- [ ] `[machine]` 无效/已用邀请码注册被拒绝。
- [ ] `[human]` Horace 确认 P5 上线检查清单全勾、完成 ≥ 5 次真实投递 dogfood（PRD §10 P5 验收标准，产品级验收，不产生额外票据）。

## Changelog

- v0.1（2026-07-17）：初稿，随 `/breakdown-prd` 生成。
- v0.2（2026-07-18，PLT-01 Builder writeback）：PLT-01（隐私政策/ToS 页 + 账号硬删）实现完成。全套测试 269 通过（27 文件），无 env var 的 `pnpm build` exit 0，lint clean。构建期 deviations（详见 `tickets/PLT-01-privacy-tos-account-delete.md` 的 Changelog）：
  - `db/index.ts` 追加 `dbTx` 导出（`drizzle-orm/neon-serverless`，纯 append，现有 `db` 导出不变）——neon-http 的 `.transaction()` 无条件抛错，无法满足 Deliverable 2(b)"单事务"要求；这是 `db/index.ts` 自身注释预授权的 swap。属跨模块 File-scope deviation，已在票据内记录并标记给 Reviewer。
  - `package.json`/`pnpm-lock.yaml` 追加 `ws`（dependency）+ `@types/ws`（devDependency），neon-serverless 的 WebSocket 传输所需；`ws` 显式传入以消除运行时原生 WebSocket 依赖的不确定性。
  - `middleware.ts` 追加 `/privacy`、`/tos` 到 `PUBLIC_PATHS`（票据 File-scope 已授权）；`middleware.test.ts` 追加对应 pass-through 断言。
  - ON DELETE CASCADE 已核对（Feedback obligation #1）：显式逐表删除与 DB 级 cascade 在单事务内严格顺序执行，不竞争；显式删除作为防御性冗余保留，使回滚原子性测试有意义。
  - 隐私政策/ToS 文案为诚实草稿，待 Horace 的 `[human]` 法务审阅（模块级验收 `[human]` 项之一），每条声明均可追溯到已合并的真实机制。
- v0.3（2026-07-19，PLT-02 Builder writeback）：PLT-02（每周备份流水线）实现完成。全套测试 278 通过（29 文件，新增 `tests/backup.test.ts` 4 项）；无新增运行时依赖（`backup.mjs` 直接 shell 调用 `pg_dump`/`aws` 二进制，未动 `package.json`）。新增 `.github/workflows/backup.yml`（每周 `schedule` cron + `workflow_dispatch`）、`.github/scripts/backup.mjs`（沿用 FND-09 `deploy-vercel.mjs` 的 no-op 守卫模式：R2/DB 凭据缺失时 exit 0 并打印跳过日志）、`tests/backup.test.ts`、`docs/ops/backup.md`（人工恢复手册），并向 `.env.example` 追加 `R2_*` 注释块。构建期 deviations（详见 `tickets/PLT-02-backup-pipeline.md` 的 Changelog）：
  - `.github/scripts/backup.mjs`、`tests/backup.test.ts`、`.env.example` 未字面列于票据 File-scope，但由票据 Test-plan/Deliverable 1 明文要求，属 File-scope 窄于 Deliverables 的既有缺口（同 FND-09 对 `deploy-vercel.mjs` 的处理），已在票据内记录并标记给 Reviewer。
  - workflow YAML 校验采用正则/子串断言（非真实 YAML parser），沿用 `tests/toolchain.test.ts` 对 `ci.yml` 的先例，避免为单条断言引入 `yaml` 依赖（plan §5 Q2，Builder 裁量）。
  - `.env.example` 的四个 `R2_*` 键以 `#` 注释形式追加，与文件中已有的裸 `KEY=` 运行时行做排版区分，强调其为 CI-only 的 GitHub Actions 仓库密钥、非 `.env.local` 值（plan §5 Q3）——这与 FND-09 完全不写入 `.env.example` 的先例有意分歧，因 PLT-02 票据明文要求追加。
  - Neon pooled-vs-direct 端点问题（票据 Feedback obligation #2）离线不可验证：`pg_dump` 对 pooled（`-pooler`/PgBouncer 事务池）端点可能失败，需改用 direct/unpooled 端点；该失败模式已前置写入 `docs/ops/backup.md` 的 Troubleshooting，待 Horace 真实 `DATABASE_URL` 就绪后于票据 Changelog 回填实际可用端点。
  - `[human]` 项仍开放：Horace 需自建 Cloudflare R2 bucket、配置 5 个 GitHub Actions 仓库密钥（含独立于 Vercel 的 `DATABASE_URL`），并经 Actions 页 `workflow_dispatch` 触发一次真实备份端到端验证，方可 P5 sign-off。
- v0.4（2026-07-20，PLT-02 Reviewer bounce fix）：Reviewer 判定 BOUNCE，四项 finding 全部修复并补回归测试。全套测试 **290 通过（29 文件，`tests/backup.test.ts` 由 4 增至 16 项）**。详见 `tickets/PLT-02-backup-pipeline.md` 的 Changelog v0.2；要点：
  - **[blocker] 静默备份损坏**：`pg_dump | gzip` 原以 `sh -c` 运行，POSIX 管道只回报末端 gzip 的退出码，`pg_dump` 失败（认证/连接错误、中途断连截断、Neon pooler 协议错误）时仍上传一个结构合法但空/截断的 `.sql.gz` 且 workflow 转绿——正是 PRD §5.6 备份要防的资产丢失。改为 `bash -o pipefail`（dash 不可靠支持 pipefail，故用 bash）使 `pg_dump` 失败传播为非零；并加上传前最小体积守卫（`MIN_BACKUP_BYTES`）作为纵深防御，拒绝空归档。
  - **[major] 上传无 region 必失败**：`aws s3 cp` 未设 region，GitHub runner 无环境/配置 region，AWS CLI v2 硬失败（"You must specify a region"）——首次真实运行必然在上传步骤失败，`[human]` 端到端验收无法通过。修复：上传子进程注入 `AWS_DEFAULT_REGION=auto`（Cloudflare R2 规定值）。
  - **[minor] pg_dump 客户端/服务端主版本不匹配**：ubuntu-24.04 stock `postgresql-client` 为 v16，而 Neon 新项目默认 Postgres 17，服务端主版本更新时 `pg_dump` 直接 abort。改为加装官方 PGDG apt 源并按 `PG_MAJOR`（默认 17）安装版本对齐的 client；`docs/ops/backup.md` Troubleshooting 补该失败模式与「按 Neon 主版本 bump `PG_MAJOR`」的指引。
  - **[blocker] 评审工件完整性**：上述 finding 1–2 的修复原仅存在于工作树、未落 commit，CLEAR 合并会漏掉修复。本次将全部修复 + changelog 回写落入 commit，使 diff 自身即含修复。
- v0.5（2026-07-23，PLT-03 Builder writeback）：PLT-03（`/admin` 可观测页）实现完成。新增 `lib/db/queries/admin.ts(+.test.ts)`、`app/(admin)/admin/page.tsx(+.test.tsx)`、`app/(admin)/_lib/admin-access.ts(+.test.ts)`；`middleware.ts` / `middleware.test.ts` / `.env.example` 均为纯追加。**PLT-03 相关 4 个测试文件 55 项全绿**；全套 407 通过 / 2 失败，两项失败均在 PLT-02 的 `tests/backup.test.ts`，已在干净 `main` 上复现验证为既有环境问题（该文件 shell 调用 `bash`，本 Windows/WSL 环境不可用），非 PLT-03 回归。无 env var 的 `next build` exit 0，`/admin` 标记为 `ƒ (Dynamic)`；未新增任何依赖，`db/schema.ts`、`db/migrations/**`、`lib/usage/record.ts` 均未触碰。构建期 deviations（详见 `tickets/PLT-03-admin-observability.md` 的 Changelog）：
  - `app/(admin)/_lib/admin-access.ts(+.test.ts)` 不在票据字面 File-scope 内，但在 `breakdown-plan.md` §3 分配给本模块的 `app/(admin)/**` 之内。该判定谓词需同时运行在 **Edge（middleware）与 Node（server component）两个 runtime**，内联两份是二者悄悄漂移的标准路径，故抽为单一定义。同 PLT-02 对 `.github/scripts/backup.mjs` 的处理，已记录并标记给 Reviewer。
  - **开放问题 #1（`/admin` 管理员鉴权机制）仍然开放，未因实现而关闭。** env var 邮箱白名单已按票据实现并双层 fail-closed（未设置 / 空 / 纯空白 / 纯逗号的 `ADMIN_EMAILS` ⇒ 无人是管理员，且谓词永不抛错），但这是本票据自己做的判断，不是 PRD 转述——它是本应用唯一的特权访问边界，属 ADR 候选，需 Horace 在 P5 上线前后确认；若改为 `isAdmin` 列或单账号硬编码，票据版本 +0.1 并在此追加 changelog 行。
  - 鉴权分两层且**以页面层为准**：middleware 返回裸 `403 Forbidden`（票据允许 redirect 或 403；403 不会循环，也不会把已登录用户弹回登录页），server component 在**任何查询之前**独立调用 `isAdminEmail` 并 `notFound()`，测试断言四个查询 mock 在被拒请求中一次都没被调用。middleware 与 Node runtime 的 env 语义不同（Next.js 会把 `process.env.ADMIN_EMAILS` 内联进 Edge bundle，**改值可能需要重新部署**，开放问题 #3 相关），故不可以"middleware 已经拦了"为由删除页面层检查。
  - 三处经实测的正确性决策：用 `percentile_disc`（`percentile_cont` 在 double precision 上插值，实测 p95 返回 `954.9999999999999`，会原样渲染到页面）；两处比率一律在 JS 里除（`sum(dropped)/count(*)` 是 bigint/bigint，Postgres 实测**截断**为 `0`；空窗口在 SQL 里会**抛** division by zero）；所有裸 `sql<number>` 聚合都加 `.mapWith(Number)`（否则 PGlite 返回 number 而 `@neondatabase/serverless` 返回 string——测试全绿、生产做字符串运算）。
  - 两处对票据字面的加性偏离：`getLatencyPercentiles` 返回 `{ p50, p95, samples }`（窗口内零事件时 `{p50:0,p95:0}` 等于断言"该阶段耗时 0 ms"，与 PRD §5.5"宁可暴露不完整，不静默吞掉"直接冲突；页面据此渲染 `—`）；三个窗口函数增加可选 `nowMs` 参数（票据的零参调用形态不变且有测试覆盖）。漏斗函数的返回形状则**有意不加宽**（不带分母），改用页面文案说明——不对称是有原则的，已在票据内说明理由。
  - 漏斗为**全时段**（票据定义未指定窗口，页面明确标注 "all time" 以区别于上方 7 天窗口）；dropped 指标标注为 "dropped items per operation" 而非比率，并在页面注明其与 PRD §6 的 Q1 `< 15%` 门槛**不可比**（后者分母是"考察的条目数"，`usage_events` 无此列）——真正的 rate 需要扩列，本票据有意不做（票据 Feedback obligation #3 / plan §5 Q3）。
  - 既有问题，未在本票据修复：`pnpm lint` 因 `node_modules` 缺 `eslint-plugin-react-hooks` 而失败（安装/提升问题，与本票据无关，`next build` 仍 exit 0）；Edge runtime 下 `auth()` 能否在 `session: { strategy: 'database' }` 中返回带 email 的 `req.auth` 离线不可验证（plan §4 R4）——若不能，本 gate 会 fail closed，但整个已登录应用也会一起挂，那是 FND-08 层面的基础设施问题。
