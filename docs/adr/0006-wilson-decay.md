# ADR-0006: Wilson 区间 z=1.96，指数衰减半衰期 60 天

- **状态**: exploration
- **日期**: 2026-05-15
- **影响**: confidence / 拦截行为

## Context

v0.1 用整数 confidence 累计，只升不降。v0.2 需要：

- 小样本保守（hits=1 不应直接到 1.0）
- 有降分通路（override = misses += 1）
- 时间衰减（一年没命中的规则应当退到 suggest 或 archived）

Wilson 区间下界是统计学经典做法。z 值常用 1.96 (95% 置信)、1.645 (90%)、2.58 (99%)。半衰期参考：人类记忆 Ebbinghaus 曲线、SRS 间隔通常以"周"为单位，规则比记忆更稳定，按"月"。

## Decision

```
wilson_lower(p̂, n, z=1.96):
  if n == 0: return prior   # 0.5 默认，confidence_hint 可微调
  let denom = 1 + z²/n
  let center = p̂ + z²/(2n)
  let halfwidth = z·√( p̂(1-p̂)/n + z²/(4n²) )
  return (center - halfwidth) / denom

decay(score, days_idle):
  return score · exp(-days_idle / 60)   # 半衰期 60 天
```

应用时机：

- 每次 `calibrate` 后写入 `wilson_lower`
- SessionStart 第一次跑且距上次衰减 ≥ 24h 时，对 `last_seen_at > 7 天` 的规则跑一次 decay

## Consequences

### Positive

- 数学上合理，行业广泛验证
- 小样本时保守、大样本时贴近真实比率
- 衰减给"过气规则"自然退场路径，无需硬阈值删除

### Negative / Risks

- 半衰期 60 天是拍的；不同领域（前端 / 后端 / DevOps）规则的"过期速度"不同
- 用户感知层面，"为什么我的规则突然不拦了"需要在 `teamagent inspect` 解释清楚

### Validation

- 验证假设：60 天半衰期下，180 天未命中的规则 wilson_lower 衰减至 ≤ 0.1，归档自然生效
- POC 路径：模拟 1 年规则演化（300 hits, 5 misses, 间歇期 10/30/90/180 天）对比 score 曲线
- 推翻迹象：用户反馈"过早衰减导致仍然有用的规则不再拦截"——改半衰期到 90/120 天
