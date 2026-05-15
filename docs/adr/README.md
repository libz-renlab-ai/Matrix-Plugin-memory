# Architecture Decision Records

teamagent-memory 所有架构决策记录。一条决策 = 一份文件，编号四位、不删不改、只新增（如改写决策，新建一份 superseded by 老条）。

## 状态约定

| 状态 | 含义 |
|---|---|
| `proposed` | 已提交，尚未讨论 |
| `exploration` | 已采纳但带 POC 验证项，POC 结果可能反推改设计 |
| `accepted` | 拍板，按此实施 |
| `rejected` | 评估后不采用 |
| `superseded` | 被新 ADR 取代（注脚指向新 ADR） |

## 索引

| ADR | 主题 | 状态 |
|---|---|---|
| [0001](0001-embedding-model.md) | 嵌入模型选型 | exploration |
| [0002](0002-semantic-threshold.md) | 语义匹配阈值 θ_sem | exploration |
| [0003](0003-block-tiers.md) | 四档拦截阈值 | exploration |
| [0004](0004-sqlite-vec.md) | SQLite 全表 vs sqlite-vec | accepted |
| [0005](0005-three-stores.md) | 三库分层 project/global/events | accepted |
| [0006](0006-wilson-decay.md) | Wilson 区间 z 值与衰减半衰期 | exploration |
| [0007](0007-fastpath-redos.md) | fast-path 正则 ReDoS 防护 | accepted |
| [0008](0008-claude-p-timeout.md) | claude -p 调用超时与降级 | accepted |
| [0009](0009-no-migration.md) | 不迁移 v0.1 JSONL 数据 | accepted |
| [0010](0010-override-classification.md) | override 分类反问机制 | accepted |

## 模板

参见 [_template.md](_template.md)。
