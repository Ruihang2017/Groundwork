# 03-library — Sub-PRD

| | |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-07-17 |
| 上游 | [docs/PRD.md](../../PRD.md) §3 C1, §4 S1, §5.1 PARSE, §5.6, §5.7, §10 P1 |
| 状态 | Draft → Gate 1 评审 |

## 问题

PRD §1 把"库从未被结构化"列为三个失败模式的共同根因，产品结构因此固定为"库是资产，JD 是流量"（PRD §0）。库必须先于任何漏斗产出存在——PRD §5.7 明确"无库时禁止新建 job"。本模块是漏斗的第一步（S1 建库），也是唯一直接持有用户简历原文/结构化项目数据写权限的模块。

## 范围 / Non-goals

**范围**：PRD §3 C1（"简历导入建库"）——PARSE stage（PDF/DOCX/粘贴 → markdown + 结构化草稿）+ 草稿确认/编辑持久化（`Library` 与 `Resume.sourceMd` 一起落库）+ Library 页展示（含空 metrics 警示）。

**Non-goals**：

- 不做 Fit/Tailor/Prep 的任何逻辑——`04-fit`/`05-tailor`/`06-prep`。
- 不做"Job 是否可新建"的 UI 判断本身（Jobs 列表页）——`04-fit`/FIT-03 拥有该页面；本模块只提供 `hasLibrary(userId)` 查询函数供其调用。
- 不为 PARSE 设置每日配额——PRD §8.3 只列出 fit/tailor/prep 三个配额桶，PARSE 没有；`01-foundation/README.md` 决策表已记录此点，本模块遵守，不额外发明。
- 不做"引导式库增值"（AI 追问补深度）——PRD §11 V1.5，触发条件未达（"库单薄成为 Q2 / 用户反馈中的可见瓶颈"），v1 不做。

## 决策

| 决策 | 依据（PRD §） |
|---|---|
| PDF 走 Anthropic 原生 document input；DOCX 经 mammoth 提取文本；粘贴纯文本兜底 | §8.1 "简历解析：PDF 走 Anthropic 原生 document input（对版式鲁棒，免解析库）；DOCX 经 mammoth 提取文本；兜底粘贴纯文本" |
| 原始文件解析后即弃，服务端不落盘、不存储文件 blob/路径 | §8.1 "**原始文件解析后即弃、不落盘**——只存 markdown 与结构化库。这是隐私决策，顺带消灭了文件存储依赖" |
| 草稿必须经用户显式确认才写入 `libraries`/`resumes` 表——LIB-01 只返回草稿，不落库；LIB-02 才在同一事务内持久化 `Library` 与 `Resume.sourceMd` | §5.1 PARSE 行 "草稿必须经用户确认才成为库"；§5.6 `Resume` 与 `Library` 同为 PARSE 的产出，一起经确认 |
| 空 `metrics` 数组是合法且必须显式展示的状态，不是错误 | §5.6 "空数组是合法且被显式展示的状态"；§5.7 "项目无 metrics 时页顶红字盘点 + 卡片级警告（P2 界面化）" |

## 拒绝的备选方案

- **PARSE 直接落库、无确认步骤**：拒绝——直接违反 §5.1 "草稿必须经用户确认才成为库"这一硬性规则；模型幻觉的项目/技能会未经审查进入资产库，污染后续所有 Fit/Tailor/Prep 产出。
- **原始文件存 R2/Blob 供审计**：拒绝——直接违反 §8.1 的隐私决策（"原始文件解析后即弃、不落盘"）；这是本产品对"别人的简历不该躺在任何地方超过处理所需时间"的立场，不是可选项。
- **`resumes` 表 v1 不落地，只持久化 `libraries`**：拒绝——曾是本模块初稿的范围，会让 `05-tailor`/TLR-01 的数字完整性校验失去真实源简历文本，只能从 `Library` 字段反推，存在漏判风险；已在 Gate 1 前修正为 LIB-02 同时持久化两者（见 `docs/prd/breakdown-plan.md` §6 开放问题 #10）。

## 开放问题

（无新增；本模块继承 `docs/prd/breakdown-plan.md` §6 汇总表中与建库相关的条目：#5 附录A seed library 资产交接，owner Horace。）

## 工作分解

| 票据 | 标题 | Size | Lane | 主要文件范围 | 依赖 |
|---|---|---|---|---|---|
| LIB-01 | PARSE API 路由 | M | 03-library | `app/api/parse/route.ts`, `lib/parse/**` | FND-02, FND-06, FND-08, FND-10, EVL-01 |
| LIB-02 | Library 与简历原文持久化 API + 查询函数 | S | 03-library | `app/api/library/route.ts`, `lib/db/queries/library.ts` | LIB-01, FND-05, FND-08 |
| LIB-03 | 草稿确认 UI + Library 页 | M | 03-library | `app/(app)/library/**` | LIB-02 |

本模块外部消费者：`04-fit`/FIT-01 依赖 LIB-02 的 `hasLibrary()`；`05-tailor`/TLR-01 依赖 LIB-02 的 `getLibrary()`/`getResume()`（见 `docs/prd/breakdown-plan.md` §4 依赖图）。

## 模块级验收

- [ ] `[fixture]` LIB-01 对 `02-evaluation`/EVL-01 的 3 份简历 fixture 全部解析出非空、Zod-valid 的草稿 Library（PRD §10 P1 验收标准 "3 份 fixture 简历解析正确"）。
- [ ] `[machine]` 空 `metrics` 的项目在 LIB-03 页面正确渲染红字盘点 + 卡片级警告（组件测试断言 DOM 内容，而非视觉判断）。
- [ ] `[machine]` 无库用户在 LIB-02 暴露的 `hasLibrary()` 查询上返回 `false`，为 `04-fit`/FIT-01 的门控提供正确输入。
- [ ] `[machine]` 确认库导入后，`getResume()` 返回与 PARSE 产出一致的 `sourceMd`，为 `05-tailor`/TLR-01 的数字完整性校验提供真实源。

## Changelog

- v0.1（2026-07-17）：初稿，随 `/breakdown-prd` 生成。
- v0.1 修订（2026-07-17，Gate 1 前）：LIB-02 范围扩展为同时持久化 `Resume.sourceMd`（原范围只覆盖 `Library`）；详见 `docs/prd/breakdown-plan.md` §6 开放问题 #10。
