# 02-evaluation — Sub-PRD

| | |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-07-17 |
| 上游 | [docs/PRD.md](../../PRD.md) §6, §7, §10 |
| 状态 | Draft → Gate 1 评审 |

## 问题

PRD §6 把"做好"定义为四道门，前三道（Q1 结构门、Q2 接地门、Q3 特异门）"进 CI 习惯（`pnpm eval`，每次 prompt / 模型改动必跑，报告落 `eval_runs`）"。这三道门是横切的：Q1 覆盖 PARSE 之外几乎每个 stage 的 schema/覆盖率/数字完整性；Q2 覆盖 CROSS 与 TAILOR 的"接地"；Q3 覆盖 REHEARSE 的"特异性"。如果 fixtures 与评测 harness 分散建在各功能模块里，每个模块都要重新决定"10 份 JD + 3 份简历从哪来""judge 怎么调"，且 P1（建库）的验收标准本身就直接点名 fixtures（"3 份 fixture 简历解析正确"）——这意味着 fixtures 必须先于第一个功能模块（`03-library`）存在。

## 范围 / Non-goals

**范围**：PRD §6 fixtures 规格（10 份 JD + 3 份简历）+ `pnpm eval` harness（judge 调用、Q1/Q2/Q3 断言函数、`eval_runs` 落库）。

**Non-goals**：

- 不实现任何 pipeline stage 本身——harness 调用的是各功能模块建好的路由/函数，本模块不重复实现 READ/CROSS/TAILOR/REHEARSE。
- 不实现 Q4（人工门）——PRD §6 明确"第四道来自真实世界"，v1 不自动化；本模块不产生任何 Q4 相关代码。
- 不做"面后回填"闭环（V1.1，PRD §11）——不在 v1 范围。
- 不产出 PRD 附录A 提到的"seed library（9 个项目）"或"1 份真实授权简历"的真实内容——这些是仓库之外的资产，需 Horace 提供（见开放问题 #1）。

## 决策

| 决策 | 依据（PRD §） |
|---|---|
| Fixtures 与 harness 在 `03-library` 之前建成，作为独立于任何里程碑的前置模块 | PRD §10 P1 验收标准直接引用 fixtures："3 份 fixture 简历解析正确" |
| `pnpm eval` 与 `01-foundation`/FND-01 建的 `pnpm test` 是两条不同命令 | PRD §6 明确点名 `pnpm eval` 作为质量门命令；`pnpm test` 服务于本仓库 `templates/ticket.template.md` 要求的标准验收项，两者断言的对象不同（单元正确性 vs. LLM 输出质量），合并会让两类验收无法分别追踪 |
| Judge 模型固定为 `claude-haiku-4-5`，从 `01-foundation`/FND-06 的 `JUDGE_MODEL` 常量读取，不在本模块重复定义 | PRD §8.1 "judge `claude-haiku-4-5`"；PRD §8.1 的模型 pin 政策要求"模型 pin 在 config" |
| Q1（结构门）断言全部为确定性代码，不调用任何模型 | PRD §6 "**Q1 结构门** | 确定性" |
| Q2/Q3（接地门/特异门）断言调用 judge 模型，产出的 pass/fail 判定本身允许人工复核覆盖 | PRD §6 "fail 样本人工复核，属实则修 prompt 并固化为回归用例" |
| `EvalRun`（`01-foundation`/FND-04 定义）的 `op` 字段取值沿用 `UsageOp` 枚举（`read`/`cross`/`tailor`/`rehearse`），不为"suite"单独发明一套 op 命名 | 复用 FND-04 已定的枚举，避免本模块重复定义一套并行的 op 分类 |

## 拒绝的备选方案

- **把 fixtures 拆到各功能模块自己维护**：拒绝——会导致同一份"10 JD + 3 简历"语料在多个模块间不一致，且 P1 的验收标准明确要求 fixtures 先于 `03-library` 存在，拆开会造成循环依赖。
- **Q1/Q2/Q3 断言写成 Playwright/E2E 测试**：拒绝——PRD 明确 Q1 是"确定性"检查、Q2/Q3 是"LLM judge"，两者都不涉及浏览器渲染；用 Vitest/Node 脚本足够，符合 §8.1"无聊技术栈"精神，不引入新的测试框架依赖。

## 开放问题

| # | 问题 | Owner |
|---|---|---|
| 1 | PRD 附录A 提到的 seed library（9 个项目）与 1 份真实授权简历均不在本仓库；EVL-01 的 3 份简历 fixture 中，PRD 要求"1 份真实授权、2 份合成"——agent 不能编造一个真实人物的授权简历（隐私/同意问题） | Horace（product）——需提供真实授权简历文本（脱敏后）或明确改为"3 份合成"，EVL-01 在此问题解决前先以 3 份 agent 编写的合成简历交付作为过渡 |
| 2 | PRD 附录A 提到的 READ/RESEARCH/CROSS/REHEARSE 四条"已调通（claude-sonnet-4-6 基线）"prompts 不在本仓库；迁移到 sonnet-5 是否可以复用其内容 | Horace（product）——需提供 prompt 文件或明确"重新产出"；`04-fit`/`06-prep` 相关票据在此问题解决前默认按 PRD §5.1 的规则从零编写 prompt |
| 3 | Q1 的"dropped < 15%"阈值、Q2 的"接地 ≥ 95%"、Q3 的"≥ 90% 特异"——这些阈值本身来自 PRD §6，是否需要按 fixture 语料的实际难度分布做样本量层面的置信区间校验 | Horace（product）——v1 直接使用 PRD 给定的名义阈值，不做统计显著性论证，触发条件与 PRD §13 Q1（SCORE 权重校准）同属"V1.1 有真实数据后再议" |

## 工作分解

| 票据 | 标题 | Size | Lane | 主要文件范围 | 依赖 |
|---|---|---|---|---|---|
| EVL-01 | Fixture 语料（10 份 JD + 3 份简历） | M | 02-evaluation | `fixtures/**` | — |
| EVL-02 | Judge harness（`pnpm eval` + Q1/Q2/Q3 断言 + `eval_runs` 落库） | M | 02-evaluation | `eval/**`, `scripts/eval.mjs` | FND-04, FND-05, FND-06, FND-07, EVL-01 |

## 模块级验收

- [ ] `[machine]` `pnpm eval` 命令存在，可对 `fixtures/**` 跑出结构化报告并写入（mock/本地）`eval_runs`。
- [ ] `[machine]` Q1 断言函数对一个人工构造的"违规样本"（如 `questions.length !== 5`）正确判定 fail。
- [ ] `[fixture]` Q2/Q3 judge 调用可对一个人工构造的"明显不接地/不特异"样本判定 fail（用 mock judge 响应验证 harness 逻辑本身，不依赖真实 API 调用产生确定性测试结果）。
- [ ] `[human]` Horace 确认/提供开放问题 #1、#2 的真实资产，或明确批准过渡方案（3 份合成简历、从零编写 prompts）。

## Changelog

- v0.1（2026-07-17）：初稿，随 `/breakdown-prd` 生成。
