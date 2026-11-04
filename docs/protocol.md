# Agent Work Bundle Protocol v0.1

中文说明 + English field notes。本协议是 **Agent Context Bridge (acb)** 的中立中间格式，用于在不同 AI Coding Agent 之间迁移三类上下文：

1. **Repo-level durable context** — AGENTS.md、rules、skills、MCP
2. **Session summary / decision log** — Agent Work State（目标、决策、待办、锚点）
3. **Lossy transcript** — 有损对话迁移（可选）

机器可读 schema：[`../schemas/agent-work-bundle.v0.1.schema.json`](../schemas/agent-work-bundle.v0.1.schema.json)  
运行时校验：Zod（`src/protocol/schema.ts`）

Work State 与诚实的 `loss_report` 是一等字段。对话层明确标为有损：能读的明文会搬进来，加密库与聊天界面不写。

---

## 顶层结构 / Top-level

```json
{
  "manifest": { ... },
  "repo_context": { ... },
  "work_state": { ... },
  "transcript": { ... }   // optional
}
```

| 字段 | 必填 | 含义 |
|------|------|------|
| `manifest` | ✓ | 版本、来源/目标 agent、时间戳、损失报告 |
| `repo_context` | ✓ | 仓库级持久上下文 |
| `work_state` | ✓ | 会话摘要 / 决策日志（可为空数组） |
| `transcript` | | 有损完整对话 |

---

## `manifest`

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `"0.1"` | 协议版本，恒为字面量 `0.1` |
| `source_agent` | string | 导出端 id，如 `cursor` / `trae` |
| `target_agent` | string? | 导入端 id（convert/import 时填写） |
| `created_at` | string | ISO-8601 时间 |
| `project_root` | string? | 导出时的项目根路径（仅供参考，导入以 CLI `--project` 为准） |
| `loss_report` | array | **诚实损失清单**（见下） |

### `loss_report[]`

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | string | 机器可读码，如 `cursor.rules.ext_normalized` |
| `message` | string | 人类可读说明 |
| `severity` | `info` \| `warn` \| `error` | 严重程度 |
| `path` | string? | 相关路径或字段 |

**约定**：凡无法保真迁移的内容，必须写入 `loss_report`，禁止静默丢弃。

本地 Web 的修复向导可以在用户明确确认或拒绝之后追加下面这些账本条目。未确认的草案不会写入 bundle。以 `repair.` 开头的条目是处理记录，向导不会再把它们当成待补的损失项。

| `code` | 何时写入 |
|--------|----------|
| `repair.applied` | 用户确认草案，对应内容已经进入 `work_state` |
| `repair.skipped` | 用户确认跳过，不修改 `work_state` |
| `repair.declined` | 用户拒绝草案，不修改 `work_state` |

---

## `repo_context`

| 字段 | 类型 | 说明 |
|------|------|------|
| `agents_md` | string? | 根目录 `AGENTS.md` 全文（便捷字段） |
| `rules[]` | RuleEntry | 规则文件 |
| `skills[]` | SkillEntry | Agent Skills（`SKILL.md`） |
| `mcp_servers[]` | McpServerEntry | MCP 服务便携子集 |
| `instructions_files[]` | InstructionsFile | `AGENTS.md` / `CLAUDE.md` 等 |

### RuleEntry

| 字段 | 说明 |
|------|------|
| `name` | 相对 rules 目录的文件名（可含子路径） |
| `content` | 含 frontmatter 的原文 |
| `always_apply` / `description` / `globs` | 从 frontmatter 归一化抽出（可选） |
| `source_path` | 导出时相对项目根的路径。用户级为 `user:.cursor/...` 或 `user:.trae/...` |
| `scope` | 可选 `project`（默认）或 `user`。`user` 只在 `--include-user` 时写回家目录 |

### SkillEntry

| 字段 | 说明 |
|------|------|
| `name` | skill 目录名 |
| `skill_md` | `SKILL.md` 全文 |
| `extras` | 同目录其他文本文件（relpath → content）；二进制不收录，并记入 `loss_report` |
| `scope` | 与规则相同：`project` 或 `user` |

### McpServerEntry

`config` 便携字段：`command` / `args` / `env` / `url` / `headers`。其它键可透传，但目标端可能丢弃并记入 `loss_report`。`scope` 与规则相同。

**安全**：用户级 MCP 的 `env` 与 headers 导出时写成 `${REDACTED}`，并记入 `loss_report`。项目级 `env` 原样保留，同时记一条警告。切勿把含密钥的 bundle 提交到公开仓库。

---

## `work_state`（Agent Work State）

这是相对「配置搬家」的差异化核心：换 agent 后真正要续上的是 **工作状态**，不是气泡原文。

| 字段 | 说明 |
|------|------|
| `goal` | 当前总目标 |
| `decisions[]` | `{ summary, rationale?, decided_at? }` 已拍板的选择 |
| `open_loops[]` | `{ summary, priority?, status? }` 未闭环事项 |
| `file_anchors[]` | `{ path, note? }` 关键文件锚点 |
| `constraints[]` | 硬约束（语言、安全、范围） |
| `known_pitfalls[]` | 已踩过的坑 |
| `last_summary` | 最近一次可粘贴进 system / @ 的摘要 |

Markdown companion：导入时若目标端无原生 Work State，适配器写入 `.acb/WORK_STATE.md` 供手动 `@`。

---

## `transcript`（可选，有损）

| 字段 | 说明 |
|------|------|
| `messages[]` | `{ role, content, tool_calls?, attachments?, dropped_fields?, timestamp? }` |
| `source_session_id` | 来源会话 id |
| `notes` | 有损说明 |

`dropped_fields` 列出本条消息丢掉的字段名（如 `tool_calls.read_file.result`）。附件默认 `omitted: true`，不内嵌二进制。

CLI 与 Web 可以读 Cursor JSONL 或 Trae 明文导出。默认不把 transcript 写进项目；确认之后只生成 `.acb/TRANSCRIPT.md`。体积上限默认 1.5 MB 或 400 条消息，超出记 `transcript.truncated`。

---

## 版本策略

- 破坏性变更升 `0.2` / `1.0`，旧 bundle 由 CLI `validate` 拒绝或经 `convert --migrate-schema`（未来）升级。
- 新增可选字段视为兼容。

## Markdown companion 示例

见导入产物 `.acb/WORK_STATE.md` 与 [`../examples/sample.bundle.json`](../examples/sample.bundle.json)。
