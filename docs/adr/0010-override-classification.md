# ADR-0010: override 分类反问机制

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: confidence 准确度 / 用户体验
- **差异化**: 这是 v0.2 超过 TeamBrain 当前公开设计的核心点

## Context

TeamBrain 文档明示：override → demerit。但 override 行为有两种语义无法用单一 demerit 表达：

1. **rule-wrong**（规则错了）：例如规则要"不要用 moment"，但当前项目跑在老 Node 上必须用 moment。用户绕开应当**强力降分**乃至归档。
2. **context-specific**（规则对，本次例外）：例如规则"不要 `git push --force`"，但当前在测试 fixture 仓库就是要强推。用户绕开**不该**让规则失效，但应该学个"例外条件"。

把两类合并为一个 demerit 会把好规则错杀。

## Decision

PostToolUse 检测到 override 后（DESIGN §8.1 的三条件），不立即扣分。改为：

1. 写 `override_detected` 事件，挂 rule_id=R
2. 下一次 `UserPromptSubmit` 检查 events.db 有未分类的 override → 注入反问 `additionalContext`（DESIGN §6.3 文本）
3. `mute-rule` skill 解析用户回复 a/b/c：
   - **a (rule-wrong)** → `rules.misses += 1`，重算 wilson，写 `override_classified` 事件
   - **b (context-specific)** → 不动 misses；从用户回复中提取"条件"（再调一次短 `claude -p`）写入 `rule_exceptions(parent_rule_id=R, condition=...)`，下次匹配 R 时如 query 满足 condition 则跳过
   - **c (skip)** → 仅写事件，规则不动
4. 用户未回复反问，**3 turn 后**仍未分类 → 自动判 (a) `rule-wrong`，避免反问污染所有后续会话

## Consequences

### Positive

- 规则准确度显著优于 TeamBrain 当前文档级设计
- "上下文例外"用结构化子规则保存，下次同上下文不再误拦
- 反问 ≤ 1 次 / override / 3 turn 内，对 UX 干扰可控

### Negative / Risks

- 提取"条件"再调一次 claude -p，会增加 Stop / 反问后的 LLM 调用成本——haiku 单次 < 1¢，影响有限
- 反问可能在用户已切到无关任务时弹出 → 通过 "3 turn 自动归判 (a)" 兜底
- `rule_exceptions` 表与 rules.embedding 不挂钩——M3 时若 condition 也想做语义匹配再扩 schema

### Validation

- M3 demo：人工制造 5 个 override 场景（3 rule-wrong, 2 context-specific），验证分类后规则演化符合预期
- 推翻迹象：用户反馈"反问太烦"且未回复率 > 50% → 改为"用户主动调 /mute-rule 才分类"，自动归 (a)
