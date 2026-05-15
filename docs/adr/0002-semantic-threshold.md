# ADR-0002: 语义匹配阈值 θ_sem = 0.78

- **状态**: exploration
- **日期**: 2026-05-15
- **影响**: 检索 / 误拦率

## Context

Layer 2 语义召回过滤阈值 θ_sem 决定多大的 cosine 相似度才算"语义相关"。太低（如 0.6）会把无关命令拉进候选；太高（如 0.9）会让语义模糊但实际同义的纠错召不回。

参考资料：e5 系列论文中，STS 任务上"同义"判定典型阈值 0.75–0.80；MS MARCO 检索任务"相关"约 0.70–0.78。

## Decision

**默认 θ_sem = 0.78**，硬编码在 `hooks/lib/match.cjs`，常量名 `SEMANTIC_THRESHOLD`。

- 仅在 Layer 1 (fast-path) 未命中时启用 Layer 2
- 取 top-K=5 候选规则
- 候选过滤 `cosine_sim >= 0.78`
- 通过后进入 candidate_score = sim × wilson_lower_bound 综合排序

## Consequences

### Positive

- 起点保守，宁可漏拦不要误拦——新版本上线时用户信任度更高
- 给 wilson_lower_bound 的"实习期"机制留空间（experimental tier 即使 sim=0.9 也 ≤ 0.45 score，只到 suggest 档）

### Negative / Risks

- 真实使用中部分中英语义跨度大的纠错可能被滤掉
- 阈值若固定不可调，不同代码库特征（自然语言比例 vs 代码比例）下表现不一致

### Validation

- 验证假设：θ_sem = 0.78 下，在 50 条 fixture 上 fast-path miss → semantic hit 的 precision ≥ 0.80
- POC 路径：调阈值 ∈ {0.70, 0.75, 0.78, 0.82, 0.85} 跑 F1 曲线
- 推翻迹象：F1 在 0.72 或 0.85 显著更高 → 改默认值并允许 `~/.teamagent/config.json` 覆盖
