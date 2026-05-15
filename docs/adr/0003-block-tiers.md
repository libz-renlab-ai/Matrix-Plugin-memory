# ADR-0003: 四档拦截阈值

- **状态**: exploration
- **日期**: 2026-05-15
- **影响**: 用户体验 / 误拦率

## Context

v0.1 是二档（deny / pass），噪声大。v0.2 引入四档 (block/warn/suggest/passive) 是为：

- 高置信规则硬拦（block）
- 中置信但相似度高的拒绝但鼓励 retry（warn）
- 模糊匹配只推荐替代不阻断（suggest）
- 低置信只软提醒（passive）

阈值 candidate_score = sim × wilson_lower_bound 的分位需要拍。

## Decision

```
score ≥ 0.85 → block
0.65 ≤ score < 0.85 → warn
0.45 ≤ score < 0.65 → suggest
0.25 ≤ score < 0.45 → passive
score < 0.25       → pass (静默)
```

对应隐含状态：

- 新 experimental 规则 (wilson ≈ 0.5)，即使 sim = 1.0，最高也只能 score = 0.5 → 落 `suggest`
- canonical 规则 (wilson ≈ 0.7)，sim = 1.0 → score = 0.7 → 落 `warn`
- canonical+ 规则 (wilson ≥ 0.85)，sim = 1.0 → score ≥ 0.85 → 落 `block`

设计意图：**新规则强制进入"实习期"**，至少需要 5 次 hits 验证后才能从 suggest 升到 warn，再后到 block。

## Consequences

### Positive

- 新规则误拦的概率被结构化压低（即使提炼器给了高 confidence_hint，wilson_lower 仍受 hits/misses 实际计数控制）
- 用户实际拒绝感受是分级的，不会被"硬拒"频繁打断

### Negative / Risks

- 高 confidence 规则需要积累 hits 才能升级到 block，初期保护效果弱
- 阈值多档增加调试复杂度

### Validation

- 验证假设：在 fixture（含 50 条规则 + 100 条命令）上，block 档 precision ≥ 0.90，warn 档 precision ≥ 0.70
- POC 路径：M3 demo 数据回放，统计每档的 false-positive rate
- 推翻迹象：block 档 precision < 0.85（误拦），或 suggest 档 recall < 0.5（漏掉真正应当提醒的）
