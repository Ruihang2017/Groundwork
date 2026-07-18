# 07-platform-launch — Sub-PRD

| | |
|---|---|
| 版本 | v0.1 |
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
