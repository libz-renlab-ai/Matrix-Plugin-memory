# ADR-0009: 不迁移 v0.1 JSONL 数据

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: 部署 / 兼容性

## Context

v0.1.0 用 `~/.teamagent/rules.jsonl` 平铺存规则。v0.2 改用三库 SQLite + embedding 列。

迁移方案候选：

1. 写 `teamagent migrate v01-to-v02` 子命令：读 jsonl → 写 SQLite，同时补齐 embedding
2. 双轨：JSONL 与 SQLite 同时写一段时间
3. 不迁移，v0.2 新起点（清空重来）

v0.1.0 刚发布、当前用户为零（仓库刚转 marketplace 结构），迁移投入价值低。

## Decision

**v0.2 完全新起点**：

- `~/.teamagent/rules.jsonl` 不读不写
- v0.2 SessionStart 检测到 `rules.jsonl` 存在时，打印一行提示：
  ```
  TeamAgent: detected v0.1 rules.jsonl. v0.2 uses SQLite (knowledge.db/global.db).
  See docs/MIGRATION.md (v0.2.0+) for manual export if needed; we do not auto-migrate.
  ```
- README 加一节 "Upgrading from v0.1"，说明手动导入步骤（用户可自己 jq + sqlite3 倒入，文档会给一段示例命令）

## Consequences

### Positive

- 实现简化：M1 不必写迁移 + 不必维护两份 schema 兼容路径
- v0.2 schema 干净，无遗留字段（v0.1 没有 embedding / scope / tier 等列）

### Negative / Risks

- 任何已经在用 v0.1 的隐性用户（论坛 / 私下分享）会遇到"规则没了"——通过提示文案 + manual import 文档兜底
- 自我承诺：v0.2 → v0.3 时，迁移**必须**实现并测试，不再开"清空重来"先例
