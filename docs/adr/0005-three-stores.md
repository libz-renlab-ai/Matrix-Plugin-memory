# ADR-0005: 三库分层 — project / global / events

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: 数据模型 / 跨项目继承 / 隐私

## Context

v0.1 把所有规则放 `~/.teamagent/rules.jsonl` 单文件。痛点：

- A 项目的 "不要直接 push main" 不该泄到 B 项目
- 但 "不要用 moment" 这种是用户全局偏好，应该跨项目
- 事件日志混在一起，规模膨胀后查询慢

TeamBrain 用三库分层（project + global + events），已验证可行。

## Decision

三个独立 SQLite 文件：

```
<repo>/.teamagent/knowledge.db   项目级规则 (含 embedding)
~/.teamagent/global.db           跨项目用户级规则 (含 embedding)
~/.teamagent/events.db           所有事件 (跨项目共享，方便聚合分析)
```

匹配时：

1. SessionStart 加载项目 + 全局两份索引，内存中按 scope 标记
2. 检索时把两份候选合并按 candidate_score 排序
3. 规则写入时由 LLM 提炼输出的 `scope_hint` 决定落到哪个库；用户可通过 `teamagent move <id> --to global` 手动调整

## Consequences

### Positive

- 项目隔离：A 项目的敏感规则不污染 B
- 全局偏好可复用：跨项目认知一次性建立
- events.db 跨项目分析能力（"我最近一周哪个项目踩坑最多？"）

### Negative / Risks

- 同步两份 schema 升级——通过 `schema_version` 表 + 单一 migration 函数解决
- `scope_hint` 由 LLM 判断，可能错放——用户能 `teamagent move`，需要这个 CLI 在 M1 就提供
- `.teamagent/` 必须在项目 .gitignore，否则规则被签入仓库（隐私问题）——README 显式提示
