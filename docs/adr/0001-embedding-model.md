# ADR-0001: 嵌入模型选型 — 默认 multilingual-e5-small

- **状态**: exploration
- **日期**: 2026-05-15
- **影响**: 检索 / 性能 / 部署体积

## Context

teamagent-memory v0.2 引入语义匹配，需要一个本地可跑、零网络依赖、对中英文 prompt 与代码命令都有合理召回质量的嵌入模型。候选：

| 候选 | 维度 | 参数 | 多语言 | 代码场景 | 推理方式 |
|---|---|---|---|---|---|
| multilingual-e5-small | 384 | 33M | ✅ | 一般 | ONNX CPU |
| bge-small-en-v1.5 | 384 | 33M | ❌ (英) | 一般 | ONNX CPU |
| nomic-embed-code | 768 | 137M | 一般 | ✅ 强 | ONNX CPU (~2-3x 慢) |
| voyage-code-3 | 1024 | — | ✅ | ✅ 极强 | 远程 API (付费) |

v0.2 已锁"只用 `claude -p`，不引入第二个 provider"——voyage-code-3 出局。

## Decision

**默认使用 `multilingual-e5-small` (384 dim, ONNX, 单文件 ~130MB)**：

- 中英文 prompt 均可：用户的"我想装个 moment" / "go ahead and install moment" 都能召回
- 体积友好：首次拉取 < 200MB，后续 0 网络
- 速度：CPU 单次推理 30-80ms（含分词），符合 hook 性能预算
- 集成路径：`onnxruntime-node` + 仓库内一份分词器 JSON

字段 `rules.embed_model` 写死 `multilingual-e5-small@v1`。M2 上线后若 POC 显示代码召回不达标，新增 ADR 切到 nomic-embed-code（schema 已用 `embed_model` 字段预留切换能力）。

## Consequences

### Positive

- 单一依赖、单文件、零外部 service
- 中英混用代码会话支持自然
- LRU 缓存 query 嵌入后，同一会话内重复命令命中 0ms

### Negative / Risks

- e5 通用嵌入对 `npm install X` / `pnpm add X` 这类纯 token 决定的语义差异不够敏感 → 这正是设计上把 **fast-path 作为首选**而非语义召回的原因（DESIGN §5.1）。规则提炼器写 `match_regex` / `match_literals` 时优先走 fast-path。
- ONNX 模型权重 130MB，首次启动有下载耗时——SessionStart 异步预热，规则匹配在权重加载完成前退到 fast-path-only。

### Validation

- 验证假设：fast-path + e5 二阶组合的拦截 precision ≥ 0.85，recall ≥ 0.70（基于 50 条人工标注 fixture）
- POC 路径：在 M2 实现完后，用 fixture 跑 precision/recall；若 recall < 0.6，触发 ADR-0011 切到 nomic-embed-code
- 推翻迹象：fast-path 命中率高（> 60%），但语义召回 precision < 0.5（误拦多于命中）
