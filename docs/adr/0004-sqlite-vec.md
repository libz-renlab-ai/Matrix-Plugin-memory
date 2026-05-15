# ADR-0004: M1 全表 cosine，M2 切 sqlite-vec

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: 性能 / 部署体积

## Context

向量近邻检索需要 ANN 索引。备选：

| 方案 | 部署 | 维度支持 | 包大小 | 速度 |
|---|---|---|---|---|
| 全表 cosine (JS 计算) | 零依赖 | 任意 | 0 | O(N)；N ≤ 500 时 < 50ms |
| `sqlite-vec` 扩展 | SQLite + .so/.dylib/.dll | 任意 | ~500KB | O(log N) HNSW |
| `chromadb` | Python daemon | 任意 | 100+ MB | 快 |
| `qdrant` | Rust daemon | 任意 | 30+ MB | 快 |

设计目标"零 daemon、纯本地、单文件"——chromadb/qdrant 出局。

## Decision

- **M1**: 全表 cosine（在 Node 里算）。规则数 ≤ 500 时性能可接受。
- **M2**: 集成 `sqlite-vec`（npm 包 `sqlite-vec`，自带跨平台预编译二进制），切到 vec0 虚表。规则数 ≥ 500 时上线。
- Schema 中 `rules.embedding` 列保留为 BLOB（float32 紧凑存）——M1/M2 行存方式一致，无需 migration。

## Consequences

### Positive

- M1 实现极简，无原生依赖
- M2 升级时 schema 不变，仅多建一个 vec0 虚表
- 用户层无感知，CLI/Skill 不动

### Negative / Risks

- M1 在规则 > 500 时性能下降明显——必须在 events.db 跟踪规则增速，及早决定 M2 时点
- `sqlite-vec` 在 Windows ARM64 的预编译二进制覆盖度需要确认（POC 项）
