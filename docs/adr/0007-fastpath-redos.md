# ADR-0007: fast-path 正则 ReDoS 防护

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: 安全 / 稳定性

## Context

PreToolUse hook 的 fast-path 用 `new RegExp(rule.match_regex, "i").test(query)`。若 `match_regex` 包含 catastrophic backtracking 模式（典型 `(a+)+b`），单次 `test()` 可能跑数秒——整个工具调用被卡死。

`match_regex` 的来源：

1. LLM 提炼器 (`claude -p`) 输出 — 不可完全信任
2. 用户手工编辑 `~/.teamagent/global.db`/`knowledge.db`
3. 历史规则（M2/M3 累积）

需要在写入路径 + 运行时两层防护。

## Decision

**写入路径** (Stop hook extract 阶段 + CLI 手工编辑导入):

1. 长度限制：`match_regex.length ≤ 512`
2. 静态 lint：拒绝匹配以下危险模式
   - 嵌套量词：`/[*+?]\)[*+]/`（如 `(a+)+`）
   - 重复贪婪 + 回溯锚点：`/[*+]\.[*+]/`
3. 编译验证：`new RegExp(pat)` 不抛 → 通过
4. 试探超时：用一个安全沙箱跑该正则 against 一段 10KB 重复字符（如 `'a'.repeat(10000)`）超过 50ms 视为失败
5. 任一失败 → 字段 `match_regex = null`，仅保留 `match_literals` fast-path，写 `rule_regex_rejected` 事件

**运行时** (PreToolUse hook):

1. `query.length ≤ 4096`（命令/编辑内容截断）
2. fast-path 总预算（所有规则正则的总执行）≤ 50ms，超过则该次 fast-path 视为未命中，继续 semantic 层
3. 由于 Node 单线程 `RegExp.test()` 无原生 timeout，使用 `setImmediate` 切片：每 N 条规则让出事件循环并检查累计耗时

## Consequences

### Positive

- 用户的 hook 永远不会被 ReDoS 卡死会话
- LLM 输出的"看起来对"但实际灾难的正则被自动剔除
- 字段 `match_regex = null` 时 fast-path 自然退化为 `match_literals` 子串匹配，仍可用

### Negative / Risks

- 部分 legit 正则（如复杂前后查找）可能被拒——可通过手动 `teamagent rule edit <id>` 强制写入（带 `--unsafe` flag），但写入仍受运行时切片保护
- 试探超时增加 Stop hook 处理时间（每条规则 +~50ms 试探）
