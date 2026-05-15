# teamagent-memory v0.2 — 设计文档

> 版本: 0.2.0-design.1 · 状态: Draft · 适用范围: M1-M3 闭环
> 上游: [TeamBrain](https://github.com/libz-renlab-ai/TeamBrain/) 借鉴 + 代码场景差异化
> 文档语言: 中文为主，标识符 / schema / 配置项保留英文

---

## §0 北极星 (North Star)

### 0.1 一句话定位

> **把一次会话里用户的纠正变成持久化、可校准、可触发的规则，让下一次会话不再重蹈覆辙——并且不在拦截路径上做昂贵动作。**

### 0.2 三件事必须做好

1. **学习 (capture)**：Stop hook 调本地 `claude -p` 把"被纠正的时刻"提炼成结构化规则，而不是依赖正则硬抓。
2. **触发 (retrieval)**：三层匹配 fast-path → semantic → BM25-lite，让代码场景 0ms 命中、模糊语义靠向量、极短命令有兜底。
3. **校准 (calibrate)**：Wilson 置信区间 + 指数衰减 + override 分类反问，让分数有升有降、有 tier 有归档。

### 0.3 不做的事 (Non-Goals for v0.2)

- ❌ 跨团队共享 / 同步（不引入网络协议）
- ❌ 多 LLM provider 适配（仅 `claude -p`）
- ❌ 编译规则反写 AGENTS.md（M5 stretch，先留 stub）
- ❌ Web UI / dashboard（CLI + Skills 输出已足够）
- ❌ JSONL → SQLite 迁移（v0.1 用户清空重来，见 ADR-009）

---

## §1 总体架构

### 1.1 一图看懂

```
                    ┌──────────────────────────────────────┐
                    │            一次会话 (session)         │
                    └──────────────────────────────────────┘

   SessionStart       UserPromptSubmit       PreToolUse        PostToolUse        Stop
   ──────────         ────────────────       ──────────         ───────────       ────
   load + gc           retrieve & inject     match & gate      record outcome    extract & calibrate
        │                     │                    │                  │                 │
        ▼                     ▼                    ▼                  ▼                 ▼
   knowledge.db         retrieve(prompt)    fast→vec→BM25      events.db       analyze → extract
   global.db                  │             block/warn/                 │       (claude -p)
                              │             suggest/passive             │       → calibrate
                              │                    │                    │       → write rule
                              │                    │                    │
                              └──── reminder ──────┘                    │
                                                                        ▼
                                                            override 检测 → 反问 hook
                                                                        │
                                                                        ▼
                                                                demerit  或  子规则
```

### 1.2 五个 hook 的职责

| Hook | 职责 | 时延预算 |
|---|---|---|
| `SessionStart` | 装载本项目 + 全局规则索引；触发后台 GC（过期归档） | < 100ms |
| `UserPromptSubmit` | 召回相关规则 → 注入 `additionalContext`，提醒不要重蹈覆辙 | < 150ms |
| `PreToolUse` (Bash/Edit/Write) | 命令/编辑内容与规则匹配 → 四档判定 (block/warn/suggest/passive) | < 200ms |
| `PostToolUse` | 记录工具调用结果 + override 检测 → 触发反问机制 | < 50ms |
| `Stop` | 跑四阶段流水线 analyze → extract → calibrate → compile | < 30s（不阻塞 UI） |

**核心原则**：**昂贵动作只在 Stop**。拦截路径 (UserPromptSubmit / PreToolUse) 只做读、嵌入、cosine 计算，不调 LLM。

### 1.3 四阶段流水线（仅 Stop）

| 阶段 | 输入 | 输出 | 实现 |
|---|---|---|---|
| `analyze` | 自上次 scan-cursor 以来的新 turn | 候选纠正时刻 list (含 ±5 turn 上下文) | 本地 JS 启发式打分 |
| `extract` | 候选时刻 | 结构化 rule (trigger/wrong/correct/why/scope) | `claude -p` headless 调用 |
| `calibrate` | 历史 hit/miss/override 序列 | Wilson 分数 + tier | 入库时同步算 |
| `compile` | (M3 之后) 高分规则 | docs/skills 摘要 | M2 留 stub |

### 1.4 三存储

| 文件 | 内容 | 何时读写 |
|---|---|---|
| `<repo>/.teamagent/knowledge.db` | 项目级规则 (含 embedding 列) | SessionStart 装载、PreToolUse 检索、Stop 写入 |
| `~/.teamagent/global.db` | 用户级跨项目规则 | 同上，跨项目继承 |
| `~/.teamagent/events.db` | 所有 hook 事件、override、工具结果 | 每个 hook 都 append |

详见 §2。

---

## §2 数据模型

### 2.1 总览

三个 SQLite 库，统一 schema 版本号 (`schema_version` 表)。所有时间戳用 ISO 8601 字符串 (UTC)。

> **为什么 SQLite 而不是 JSONL？**
> JSONL 在并发 append 下容易撕裂；规则数 > 100 时全表读 + 反序列化每次 hook 都吃 50ms+；语义检索几乎无法实现。SQLite 单文件、零运维、`better-sqlite3` 同步 API、~1MB 包大小。

### 2.2 `knowledge.db` / `global.db` schema

```sql
-- 模式版本：迁移时通过此判断
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- 主表：规则卡
CREATE TABLE rules (
  id              TEXT PRIMARY KEY,        -- rule-YYYY-MM-DD-<wrong>-<correct>
  scope           TEXT NOT NULL,           -- 'project' | 'global'
  tier            TEXT NOT NULL,           -- 'experimental' | 'canonical' | 'canonical+' | 'archived'

  -- 规则内容
  wrong           TEXT NOT NULL,           -- 一句话描述"错的做法"
  correct         TEXT NOT NULL,           -- 一句话描述"对的做法"
  why             TEXT NOT NULL,           -- 一句话理由（由 extract 阶段 LLM 生成）

  -- 触发器（fast-path）
  match_regex     TEXT,                    -- 编译期已校验的正则 (可空)
  match_literals  TEXT,                    -- JSON 数组 string[] (可空)
  match_tools     TEXT NOT NULL,           -- JSON 数组 ['Bash','Edit','Write'] 子集
  match_scope_globs TEXT,                  -- JSON 数组 ['package.json','**/*.ts'] (可空，仅 Edit/Write)

  -- 语义匹配
  embedding       BLOB,                    -- float32[384] 紧凑存
  embed_model     TEXT,                    -- 'multilingual-e5-small@v1' (允许未来切模型)
  embed_text      TEXT NOT NULL,           -- 用于嵌入的归一化文本: f"{wrong}. {correct}. {why}"

  -- Confidence
  hits            INTEGER NOT NULL DEFAULT 0,
  misses          INTEGER NOT NULL DEFAULT 0,   -- override = 'rule-wrong' 计
  exceptions      INTEGER NOT NULL DEFAULT 0,   -- override = 'context-specific' 计
  wilson_lower    REAL NOT NULL DEFAULT 0.5,    -- Wilson 95% 区间下界（用于排序与判定）
  last_seen_at    TEXT,                          -- 最近一次匹配命中时间
  last_demerit_at TEXT,                          -- 最近一次扣分时间

  -- 溯源
  captured_at     TEXT NOT NULL,
  session_origin  TEXT,
  source_text     TEXT,                    -- ≤ 800 字符的原始纠正片段（去掉密钥/路径）
  evidence_json   TEXT                     -- JSON: { transcript_path, hook_event_id, turn_index }
);

CREATE INDEX idx_rules_tier_score ON rules(tier, wilson_lower DESC);
CREATE INDEX idx_rules_last_seen ON rules(last_seen_at);
-- 嵌入近邻：M1 全表扫；M2 切 sqlite-vec 后建 vec0 虚表

-- 子规则：override='context-specific' 时挂到父规则下
CREATE TABLE rule_exceptions (
  id              TEXT PRIMARY KEY,
  parent_rule_id  TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  condition       TEXT NOT NULL,           -- 一句话条件：'in test fixtures'
  example         TEXT,
  captured_at     TEXT NOT NULL
);
CREATE INDEX idx_exc_parent ON rule_exceptions(parent_rule_id);

-- 增量扫描游标
CREATE TABLE scan_cursor (
  transcript_path TEXT PRIMARY KEY,
  last_turn_index INTEGER NOT NULL,
  updated_at      TEXT NOT NULL
);
```

### 2.3 `events.db` schema

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- 见下方枚举
  session_id    TEXT,
  rule_id       TEXT,                      -- 关联 rules.id（可空）
  hook_name     TEXT,                      -- 'PreToolUse' / 'Stop' / ...
  tool_name     TEXT,
  decision      TEXT,                      -- 'block'|'warn'|'suggest'|'passive'|'pass'
  score         REAL,                      -- candidate_score, 0-1
  payload_json  TEXT                       -- 紧凑 JSON: 命令/截断后内容/exit_code/error
);

CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_rule ON events(rule_id, ts);
CREATE INDEX idx_events_session ON events(session_id);
```

**`kind` 枚举**：

| kind | 写入者 | 含义 |
|---|---|---|
| `session_start` | SessionStart hook | 装载完成 |
| `prompt_match` | UserPromptSubmit | 召回到 N 条规则 |
| `pretooluse_block` / `_warn` / `_suggest` / `_passive` / `_pass` | PreToolUse | 四档判定 |
| `posttool_ok` / `posttool_fail` | PostToolUse | 工具执行结果 |
| `override_detected` | PostToolUse | 检测到用户绕开规则 |
| `override_classified` | Skill 反问后 | rule-wrong / context-specific |
| `stop_analyze` / `stop_extract` / `stop_calibrate` | Stop | 各阶段结果 |
| `rule_created` / `rule_updated` / `rule_archived` | 各处 | 规则生命周期 |
| `gc_run` | SessionStart | GC 报告 |

### 2.4 文件位置约定

```
<repo>/.teamagent/
  knowledge.db
  scan_cursor.json     # 仅在 SessionStart 同步到 DB 的 scan_cursor 表

~/.teamagent/
  global.db
  events.db
  models/
    multilingual-e5-small.onnx
    tokenizer.json
```

`.teamagent/` 默认加入仓库 `.gitignore`（项目模板）。

---

## §3 Hook 详细设计

每个 hook 都遵守三条铁律：

1. **永不破坏会话**：异常一律 `try/catch`，stderr 打印一行错误，进程退出 0。
2. **stdin/stdout 是协议**：读 JSON in，写 JSON out（或空）。
3. **预算硬上限**：超时即降级为"无规则"行为，记 `events.db` 一条 fallback。

### 3.1 `SessionStart`

**职责**：

- 检查 `knowledge.db` / `global.db` schema 版本，必要时 migrate
- 触发 GC：把 `tier='canonical+'` 且 `last_seen_at` 超 180 天的转入 `archived`；把 `experimental` 超 30 天且 hits=0 的归档
- 写一条 `session_start` 事件

**降级**：DB 文件损坏 → 写错误事件、本会话规则索引为空（用户体验无规则）。

### 3.2 `UserPromptSubmit`

**职责**：

- 取 `event.prompt`
- 跑三层匹配（§5），取候选规则前 5 条
- 拼成 `additionalContext` 注入：
  ```
  TeamAgent 提醒（不要重蹈覆辙）：
  - [rule-2026-05-13-moment-dayjs] 不要用 moment；用 dayjs；理由：moment 已 deprecated。confidence: canonical (0.82)
  - ...
  ```
- 写 `prompt_match` 事件

**降级**：

- 嵌入失败 → 仅跑 fast-path + BM25-lite
- DB 锁 → 跳过注入

### 3.3 `PreToolUse`（Bash / Edit / Write）

**输入归一化**（不同工具取不同字段）：

| tool_name | query 提取 |
|---|---|
| `Bash` | `tool_input.command` |
| `Edit` | `tool_input.new_string` 前 200 字符 + " :: " + `path.basename(file_path)` |
| `Write` | `tool_input.content` 前 500 字符 + " :: " + `path.basename(file_path)` |

**匹配流程**：

1. 跑三层匹配（§5）拿 candidate 列表（每条带 cosine_sim 或 fast-path 命中标记）
2. 对每条 candidate 计算
   `candidate_score = sim * wilson_lower_bound(rule.confidence)`
   （fast-path 命中时 sim 视为 1.0）
3. 取最大 score，按阈值落到四档（§7）
4. 写对应 `pretooluse_*` 事件

**降级**：嵌入失败仅退到 fast-path；regex 编译失败该规则视为无 fast-path。

### 3.4 `PostToolUse`

**职责**：

- 把工具执行结果写 `events.db`（exit_code / stderr_excerpt / duration_ms）
- **Override 检测**：当本轮 PreToolUse 是 `block` 或 `warn`，但同一 session_id 后续 2 个 turn 内出现近似命令且执行成功 → 认定为 override，写 `override_detected` 事件，挂到那条 rule.id 上
- 不做规则修改（修改在 Stop 阶段集中跑，避免锁竞争）

### 3.5 `Stop`

跑四阶段流水线，详见 §4。

---

## §4 Stop hook：四阶段流水线

### 4.1 `analyze` — 找候选时刻

**输入**：transcript 全文 + scan_cursor.last_turn_index

**算法**：从 `last_turn_index` 起遍历每个 user/assistant turn，按下表打"候选分"：

| 信号 | 分数 |
|---|---|
| 用户消息匹配 v0.1 的 6 条正则（不要用 X 用 Y）| +3 |
| 用户消息含 "不对/不要/不应该/错了/别用/instead/wrong" + 否定对象 | +2 |
| 上一条是工具调用且本条为用户消息 | +1 |
| 用户消息 ≤ 200 字符 | +1 (短消息更可能是直接纠正) |
| 当前 turn 处于 events.db 一个 `pretooluse_warn`/`block` 后 30s 内 | +2（override 信号） |
| 用户消息含成功信号 ("ok 这样可以", "good", "works") + 距离上次 fail < 5 turn | +1 (成功传播信号) |

候选分 ≥ 3 的 turn 进入下一阶段。一次 Stop 最多取 top-5 候选，避免提炼超时。

**输出**：`[{turn_index, context_turns: [...±5 turn], hint_score, signal_kind: 'correction'|'success'}]`

### 4.2 `extract` — 调本地 `claude -p` 提炼

**调用方式**：

```bash
claude -p --model claude-haiku-4-5 --output-format json \
        --max-turns 1 --disallowed-tools '*' \
        < <(echo "$PROMPT")
```

> 选 haiku：足够便宜（每次 < 1¢）、快（典型 < 5s）、规则提炼用不到深度推理。

**Prompt 模板**（schema 化输出）：

```
你是 TeamAgent 的规则提炼器。给定一段 Claude Code 会话片段，
提炼成结构化 JSON。

输入片段（按时间顺序，最近的在最后）：
<<<
{context_dump}
>>>

任务：判断这段对话里是否包含一条**可执行的、跨会话有用的规则**。

输出 JSON（不要 markdown，不要解释）：
{
  "is_actionable_rule": true|false,
  "wrong": "<一句话: 错的做法>",
  "correct": "<一句话: 对的做法>",
  "why": "<一句话: 理由>",
  "scope_hint": "project"|"global",
  "match_regex": "<可选: 一个能精确命中错的做法的正则；不确定就置 null>",
  "match_literals": ["<可选: 关键字数组>"],
  "match_tools": ["Bash"|"Edit"|"Write"],
  "confidence_hint": 0.0-1.0
}

判 false 的情形（必须 false）：
- 用户在吐槽，不是要求规则化
- 一次性偏好（"这次先这样"）
- 跟具体业务上下文紧绑（"这个项目里不要用 X"应当 scope='project'，仍可记录）
- 涉及凭据/路径/邮箱等隐私
```

**超时与降级**：

- `claude -p` 超时 30s → kill，写 `stop_extract_timeout` 事件
- 输出不是合法 JSON → 重试 1 次；仍失败则 `is_actionable_rule=false`
- 模型未安装/CLI 不存在 → 整个 extract 阶段跳过，留 analyze 候选给下次

**幂等保护**：每个候选用 `sha256(transcript_path + turn_index)` 做 dedupe key，存到 `events.db` 中 `kind='stop_extract'` 事件的 `payload_json.dedup_hash` 字段；下次 Stop 跑前查表，已处理的不重复送模型。

### 4.3 `calibrate` — Wilson 区间打分

**新规则**：

- `hits=0, misses=0, exceptions=0`
- `wilson_lower = 0.5`（先验中性，confidence_hint > 0.7 时上调到 0.55，> 0.9 时 0.6）
- `tier = 'experimental'`

**复用规则**（同 `embed_text` 哈希）：

- `hits += 1`, `last_seen_at = now`
- 重算 `wilson_lower` (z=1.96, n=hits+misses)

**升降信号矩阵**（详见 §6）：

| 事件 | hits | misses | exceptions |
|---|:---:|:---:|:---:|
| `pretooluse_block` 后无 override | +1 | | |
| `pretooluse_warn` 用户接受替代 | +1 | | |
| `override_classified = 'rule-wrong'` | | +1 | |
| `override_classified = 'context-specific'` | | | +1 |
| 自动衰减（每 30 天未命中） | -0.5 (浮点) | | |

**Tier 升降**：

| 当前 tier | 升 → | 降 → |
|---|---|---|
| `experimental` | `wilson_lower ≥ 0.7` 且 hits ≥ 5 → `canonical` | `misses ≥ 3` 或 30 天 hits=0 → `archived` |
| `canonical` | `wilson_lower ≥ 0.85` 且 hits ≥ 20 → `canonical+` | `misses ≥ 5` → `experimental` |
| `canonical+` | — | `misses ≥ 5` → `canonical` |
| `archived` | 不参与匹配 | — |

### 4.4 `compile` — M3 之前留 stub

仅写一条 `compile_skipped` 事件。M3 后实现"高分规则 → 项目 AGENTS.md / Skills 索引"传播。

---

## §5 检索与匹配（语义匹配核心）

详细见 §1.5，本节补充打分公式与边界。

### 5.1 三层匹配的细则

**Layer 1 Fast-path**：

- 规则有 `match_regex` 时：`new RegExp(match_regex, "i").test(query)`
- 或 `match_literals` 中任一作为子串出现
- 命中返回 `sim = 1.0`，跳过下面两层
- **ReDoS 防护**：写入时 lint（拒绝 `(a+)+` 类嵌套量词）；运行时正则长度 ≤ 512 字符；执行时设 5ms timeout（使用 `RegExp` 不支持原生 timeout，采用预扫描启发式 + 字符长度限制）

**Layer 2 Semantic**：

- 嵌入 query，归一化
- 全表（M1）或 sqlite-vec（M2）取 top-K=5 cosine 近邻
- 过滤 `sim ≥ 0.78`（θ_sem，ADR-002）

**Layer 3 BM25-lite**（仅当 query.length < 30 且 Layer 2 全失败）：

- 对 `rules.match_literals` 与 query 分词后做 IDF 加权重叠
- 命中阈值：score ≥ 0.3
- 返回 `sim = 0.5`（区分于上面两层；用 wilson 加权后通常只能落到 suggest 档）

### 5.2 候选打分

```
candidate_score = sim × wilson_lower_bound(rule)
```

其中 `wilson_lower_bound` 即 `rules.wilson_lower` 列。这使得：

- 新 experimental 规则 `wilson_lower ≈ 0.5`，即使完美字符串匹配最终 score ≤ 0.5 → 落到 `suggest` 而非 `block`
- canonical+ 规则 `wilson_lower ≥ 0.85`，模糊语义匹配也可触发 `warn`

### 5.3 边界与已知限制

- query 截断（200/500 字符）会丢失长文件中后面的代码上下文 → M2 增加分块滑窗
- e5-small 多语言通用，对纯代码 token 区分度不如代码专用模型 → ADR-001 探验
- ANN 暂用全表，规则 > 500 后性能 SLO 不达 → M2 上 sqlite-vec

---

## §6 Confidence 与生命周期

### 6.1 为什么用 Wilson 而不是简单计数

简单 `hits/(hits+misses)` 在小样本下噪声大（hits=1, misses=0 直接 1.0，明显错误）。Wilson 95% 区间下界给小样本一个保守估计，样本变多后逼近真实比率。

```
wilson_lower(p̂, n, z=1.96) =
  (p̂ + z²/(2n) - z·√(p̂(1-p̂)/n + z²/(4n²))) / (1 + z²/n)
```

其中 `p̂ = hits / (hits + misses)`，`n = hits + misses`。`exceptions` 不进 misses（不算"规则错"），只挂例外子规则。

新规则 n=0 时直接给 prior 0.5（或按 `confidence_hint` 微调，见 §4.3）。

### 6.2 时间衰减

每天凌晨（SessionStart 第一次跑时检查"距今 ≥ 1 天未跑衰减"），对所有 `last_seen_at > 7 天` 的规则：

```
days_idle = (now - last_seen_at) / 86400
decay = exp(-days_idle / 60)        # 半衰期 60 天
wilson_lower *= decay
```

这让长期不命中的规则缓慢褪色——而不是硬截断。

### 6.3 Override 分类是关键差异点

PostToolUse 检测到 override 后，下一次 `UserPromptSubmit` 注入一段反问 context：

```
TeamAgent 注意到你刚才绕开了规则 [rule-2026-05-13-moment-dayjs]。
为了让规则库准确，可以告诉我是哪种情形吗？
  (a) 这条规则错了 / 不再适用
  (b) 规则对，但本次有特殊上下文（不会推广）
  (c) 不用管
```

回答驱动 `mute-rule` skill（新增，§11）：

- (a) → `misses += 1`，可能触发 tier 下降或归档
- (b) → 从用户回复中再调一次短 `claude -p` 提取 `condition`（一句话），写入 `rule_exceptions`；下次匹配遇到同一 `condition` 时跳过该 rule。详见 ADR-0010
- (c) → 不动分数

> **超过 TeamBrain 的地方**：TeamBrain 文档可见的设计里 override 直接 demerit。我们把它一分为二，规则库准确度更高。

### 6.4 GC 与归档

- `tier='archived'` 的规则不进入匹配但保留可恢复
- 超过 365 天且未恢复的归档规则物理删除（写 `rule_archived_purged` 事件）

---

## §7 拦截四档策略

### 7.1 阈值

| 档位 | candidate_score | hook 输出 | 用户体验 |
|---|---|---|---|
| `block` | ≥ 0.85 | `permissionDecision: "deny"` | 命令被硬拒，输出 reason + correct |
| `warn` | 0.65 – 0.85 | `permissionDecision: "deny"` + 提示 retry | 拒绝但鼓励再发一遍（被错误 block 的成本低） |
| `suggest` | 0.45 – 0.65 | `permissionDecision: "ask"` + 替代命令 | 用户决定走不走 |
| `passive` | 0.25 – 0.45 | 不阻断，但在下一次 UserPromptSubmit 注入 reminder | 软提醒 |
| `pass` | < 0.25 | 不阻断，不提醒 | 静默 |

阈值标 ADR-003 exploration。

### 7.2 拒绝消息格式（block / warn）

```
TeamAgent rule rule-2026-05-13-moment-dayjs blocks this.
- wrong:   <rule.wrong>
- correct: <rule.correct>
- why:     <rule.why>
- score:   0.91 (sim=0.95, wilson=0.96, tier=canonical+)
- hits/misses: 24/0; last_seen 2026-05-12

如果这是误判：
  > /mute-rule rule-2026-05-13-moment-dayjs
或带上下文重发命令时附加 "<<exception: <one-line reason>>>"
```

### 7.3 Skill：`explain-rule-hit` 复用

v0.1 已有，v0.2 扩展为多档解释 + 引导用户使用 `mute-rule`。

---

## §8 Override 反馈闭环

详见 §6.3 的反问机制。本节补充实现要点。

### 8.1 检测窗口

PostToolUse 每次写完 `posttool_*` 事件后，回看本 session 最近 5 个 events：

- 是否有 `pretooluse_block`/`_warn`，rule_id = R
- 当前命令与该 PreToolUse 的 query 字符串相似度 ≥ 0.75（用同一嵌入模型）
- 当前执行 `posttool_ok`

三条同时满足 → 写 `override_detected`，rule_id=R。

### 8.2 反问触发

下一个 `UserPromptSubmit` 检查 events.db 有无未分类的 `override_detected` 事件：

- 有 → 注入反问 context（§6.3）
- 同时写 `override_prompt_injected` 事件

用户的下次回复由 `mute-rule` skill 解析为 a/b/c，写 `override_classified`，并按 §6.3 更新规则。

### 8.3 兼容简单情况

用户没回复反问，再次 override 同一规则 → 默认按 (a) `rule-wrong` 处理。避免无限循环反问。

---

## §9 错误处理、降级与性能预算

### 9.1 性能预算

| Hook | 目标 P50 | 目标 P95 | 超时硬上限 | 超时降级 |
|---|---|---|---|---|
| SessionStart | 50ms | 100ms | 500ms | 跳过 GC，继续 |
| UserPromptSubmit | 60ms | 150ms | 500ms | 仅 fast-path |
| PreToolUse | 80ms | 200ms | 500ms | 仅 fast-path |
| PostToolUse | 10ms | 50ms | 200ms | 跳过 override 检测 |
| Stop | 5s | 30s | 60s | 跳过 extract，留 analyze 候选 |

测量：每个 hook 入口/出口记 `duration_ms` 到 `events.db.payload_json.duration_ms`。

### 9.2 错误分类

| 错误 | 行为 |
|---|---|
| 嵌入模型未下载 | SessionStart 自动拉，失败则全程仅 fast-path |
| `claude -p` 缺失 | Stop 跳过 extract，分析候选写 `analyze_only` 事件 |
| SQLite busy / locked | 退避 50ms 重试 3 次，仍失败则放弃本次写但不破坏会话 |
| Schema 版本不匹配 | SessionStart 跑 migration；migration 失败 → 锁住 DB 文件、用户手动 `teamagent doctor` |
| 正则编译失败 / 超长 | 该规则的 fast-path 视为缺省，记 `rule_invalid` 事件 |

### 9.3 损坏与恢复

- `~/.teamagent/backup/` 保存每 7 天一次 DB snapshot（最多 4 份）
- `teamagent doctor` 子命令：自检 schema + 完整性 + 嵌入维度一致性

---

## §10 隐私与安全

- **绝不**把以下进 rules.source_text：邮箱（regex 抓后置 `<email>`）、绝对路径（替换为 `<path>`）、看起来像 token 的串（≥ 20 字符的 alnum）、URL 上的 query 参数
- `source_text` 截断到 800 字符
- 三个 DB 文件 mode 0600
- 用户可 `teamagent export --rule <id>` 导出审计；`teamagent forget --rule <id>` 物理删除（含 events 关联行）

---

## §11 CLI 与 Skills

### 11.1 CLI 子命令

继承 v0.1 + 新增：

| 命令 | 行为 |
|---|---|
| `teamagent list [--tier canonical+] [--scope project]` | 列规则 (按 wilson_lower 排序) |
| `teamagent inspect <id>` | 详情（含 hits/misses/exceptions/最近事件） |
| `teamagent events [N] [--rule R]` | tail 事件 |
| `teamagent mute <id>` | 直接转 `archived` |
| `teamagent demote <id>` | misses+=1，重算 tier |
| `teamagent promote <id>` | hits+=1（人工管理逃生口） |
| `teamagent doctor` | 自检 |
| `teamagent export [--rule id]` | JSON 导出 |
| `teamagent forget --rule id` | 物理删除 |
| `teamagent gc [--dry-run]` | 手动跑一遍 GC |
| `teamagent --version` | 版本 |

### 11.2 Skills

| Skill | 状态 | 用途 |
|---|---|---|
| `capture-correction` | 保留并升级 | 文档同步更新到"由 LLM extract 而非正则"；保留手动调用入口 |
| `explain-rule-hit` | 保留扩展 | 解释四档拦截，引导 `mute-rule` |
| `review-new-rules` | 保留扩展 | 支持按 tier/scope 筛 |
| `mute-rule` | **新增** | 处理用户的反问回复 (a/b/c)，写入 misses/exceptions |
| `rule-doctor` | **新增** | 自检与诊断的 Skill 包装 (调 `teamagent doctor`) |

---

## §12 测试策略

### 12.1 三层金字塔

**单元测试** (vitest)：

- 每个 hook 的纯函数：`extractCorrection`, `buildPattern`, `wilsonLowerBound`, `decayScore`, `classifyOverride`
- 表驱动：固定 input → 固定 output

**集成测试**：

- Fixture transcript JSONL（含 8-10 个典型纠正场景）→ 跑 Stop hook → 校验 `knowledge.db` 中 rule 数 & 字段
- 模拟 PreToolUse stdin → 校验 stdout JSON 决策

**端到端 (smoke)**：

- 跑 `claude --debug` 真实拉起 hooks，喂一段脚本对话，确认事件链完整
- 在 CI 用 Claude Code 的 `--plugin-dir` 指向本仓库

### 12.2 关键 invariants

- 任意 hook 异常退出码必须为 0（fuzz 输入）
- Schema migration 幂等：跑两次结果一致
- GC 不动 `last_seen_at < 7 天` 的规则
- 同一候选 turn 跑 extract 两次不重复入库（hash dedupe）

### 12.3 性能基准

- 1000 条规则，PreToolUse P95 < 200ms（含嵌入）
- Stop hook 5 候选 → < 30s（含 5 次 claude -p 调用，串行）

---

## §13 路线图

### M1 — 基础替换（2-3 天）

- [ ] SQLite schema + 三库初始化 + `teamagent doctor`
- [ ] Stop hook: analyze (v0.1 启发式打分增强) + extract (claude -p) + calibrate (Wilson)
- [ ] Confidence 升降矩阵 + 时间衰减
- [ ] 四档拦截（block/warn/suggest/passive）
- [ ] 单元 + 集成测试覆盖关键路径

### M2 — 语义匹配（3-4 天）

- [ ] 嵌入模型集成（onnxruntime-node + e5-small）
- [ ] sqlite-vec 集成 + 全表 fallback
- [ ] 三层匹配实现 + 阈值预设
- [ ] LRU 缓存 query 嵌入
- [ ] 性能基准达标 (1000 规则 P95 < 200ms)

### M3 — 反馈闭环（2 天）

- [ ] PostToolUse override 检测窗口
- [ ] `mute-rule` skill + 反问注入
- [ ] `rule_exceptions` 表 + 匹配时跳过逻辑
- [ ] 端到端 demo：误拦 → 反问 → 子规则挂载 → 下次不拦

### 后续（不在 v0.2）

- M4：项目/全局冲突解决策略
- M5：compile（反向写 AGENTS.md / Skills）
- M6：MCP 暴露给其它 agent

---

## §14 ADR 索引

放在 `docs/adr/` 下，编号四位数。每条 ADR 单文件。

| ADR | 主题 | 状态 |
|---|---|---|
| [ADR-0001](adr/0001-embedding-model.md) | 嵌入模型选 e5-small 还是 nomic-embed-code | exploration |
| [ADR-0002](adr/0002-semantic-threshold.md) | 语义阈值 θ_sem | exploration |
| [ADR-0003](adr/0003-block-tiers.md) | 四档拦截阈值 (0.85/0.65/0.45/0.25) | exploration |
| [ADR-0004](adr/0004-sqlite-vec.md) | M1 全表 vs sqlite-vec | accepted |
| [ADR-0005](adr/0005-three-stores.md) | 三库分层 (project/global/events) | accepted |
| [ADR-0006](adr/0006-wilson-decay.md) | Wilson z=1.96 + 半衰期 60 天 | exploration |
| [ADR-0007](adr/0007-fastpath-redos.md) | fast-path 正则 ReDoS 防护 | accepted |
| [ADR-0008](adr/0008-claude-p-timeout.md) | claude -p 超时 30s + 降级 | accepted |
| [ADR-0009](adr/0009-no-migration.md) | v0.2 不做 JSONL → SQLite 迁移 | accepted |
| [ADR-0010](adr/0010-override-classification.md) | override 分类反问机制 | accepted |
| [ADR-0011](adr/0011-effective-wilson.md) | effectiveWilson floor at prior until n>=5 | accepted |
| [ADR-0012](adr/0012-m4-decisions.md) | M4: semantic exceptions + 3-turn auto-classify + project precedence | accepted |

---

## §15 开放问题（写出来防遗忘）

1. e5-small ONNX 推理在 Windows + Node 20 上未实测——POC 第一周确认。
2. `claude -p --output-format json` 不同 Claude Code 版本可能字段名变化，要在 SessionStart 探测。
3. PostToolUse override 检测中"近似命令"的相似度阈值 0.75 是拍的，需 POC 数据校准。
4. SQLite 在 Windows 上的并发 write 会不会跟 hook 多进程冲突？需 fuzz 测。
5. M3 反问注入时若用户已切到下一个无关任务，体验如何？需做"超过 N 个 turn 自动放弃反问"的回退。

---

*文档结束 · 任何变更走 ADR · M1 实现开始前再过一次 user review*
