# ADR-0008: `claude -p` 调用超时 30s，失败可降级

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: 学习质量 / 稳定性

## Context

Stop hook 的 extract 阶段调本地 `claude -p` 把候选时刻提炼为结构化规则。该调用是整个流水线最不可控的部分：

- 用户本地 Claude Code 可能未登录
- API 拥塞导致响应慢
- 模型偶尔返回非 JSON

Stop hook 总预算 30s 硬上限（DESIGN §9.1），其中要给多个候选时刻留时间。

## Decision

**调用参数**：

```bash
claude -p \
  --model claude-haiku-4-5 \
  --output-format json \
  --max-turns 1 \
  --disallowed-tools '*' \
  --append-system-prompt "<systemprompt>" \
  < <(echo "$user_prompt")
```

- `--model`: 默认 haiku（便宜+快）；环境变量 `TEAMAGENT_EXTRACT_MODEL` 覆盖
- `--disallowed-tools '*'`: extract 不允许用任何工具，纯 JSON 输出
- `--max-turns 1`: 一次往返足够

**超时与降级**：

| 情形 | 行为 |
|---|---|
| 单次调用 > 30s | `kill -TERM` → 5s 后 `kill -KILL`；写 `stop_extract_timeout` 事件 |
| 调用返回非 0 退出码 | 写 `stop_extract_error` 事件，含 stderr 摘要 |
| 输出不是合法 JSON | 重试 1 次（同一 prompt + 提示"上次输出无效"前缀）；仍失败则 `is_actionable_rule=false` |
| `claude` 二进制找不到 | SessionStart 探测一次，缺失则该会话 extract 阶段直接 skip |
| 单次 Stop 中累计 extract 耗时 > 25s | 跳过剩余候选，写 `stop_extract_skipped_remainder` |

**并发**：候选时刻 **串行**调用 `claude -p`（避免短时间内多次 spawn 影响主 CC 体验）。最多 5 个候选 / 次 Stop。

## Consequences

### Positive

- 永不阻塞用户的下一次 prompt（Stop hook 在 SDK 层异步执行）
- 失败有完整审计 trail
- 用户没有装 Claude Code 仍能用 v0.2 的拦截功能（仅失去 LLM 学习）

### Negative / Risks

- 串行 5 候选最坏 5 × 5s = 25s——若需要更高吞吐 M2 引入候选合并（一次 prompt 多个候选）
- haiku 在罕见模糊 case 上判断可能不如 sonnet 准——`TEAMAGENT_EXTRACT_MODEL=claude-sonnet-4-6` 可手动升级
