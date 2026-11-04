# Adapters: Cursor & Trae

本文记录 **已核实** 的路径与「可迁 / 有损」边界，供实现与诚实 `loss_report` 使用。调研日期：2026-11（Asia/Shanghai）。

本项目焦点是 **Work Bundle + Work State**。第一批适配器仅为 Cursor 与 Trae。配置会迁移，但每次丢字段、改扩展名或跳过加密库都会写入 `loss_report`。

---

## Cursor

官方文档：[Rules](https://cursor.com/docs/rules) · [MCP](https://cursor.com/docs/mcp)

### 项目级（Layer 0 — 已扫描）

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| AGENTS.md | 根目录与子目录 `AGENTS.md` / `CLAUDE.md` | ✅ 全文。根文件进 `agents_md`，其余进 `instructions_files` |
| Project rules | `.cursor/rules/**/*.mdc`，含嵌套模块目录 | ✅；纯 `.md` 会被 Cursor **忽略**，导入时补 frontmatter 并改为 `.mdc` |
| 对方布局 | 同一轮导出也会读 `.trae/rules` 与 `.trae/skills` | ✅ 用 `source_path` 映射回去；记 `repo.other_layout_included` |
| Skills | `.cursor/skills/<name>/SKILL.md`；亦发现 `.agents/skills/` | ✅ 文本 extras；二进制记 `skills.binary_omitted` |
| MCP | `.cursor/mcp.json` → `mcpServers` | ✅ 便携子集。项目级 `env` **不**脱敏，记 `mcp.env.unredacted` |

### 用户级（`--include-user`）

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| MCP | `~/.cursor/mcp.json` | ✅ 与已有文件按名字合并，不删除未出现的 server。`env` / headers 写成 `${REDACTED}` |
| Skills | `~/.cursor/skills/` | ✅ 文本 |
| Rules | `~/.cursor/rules/` | ✅ |
| User Rules（账号同步） | 应用内，**无稳定文件** | ❌ 记 `cursor.user_rules.account_only` |

越出家目录的符号链接记 `user_scope.symlink_skipped`，不跟随。未加 `--include-user` 时，bundle 里的用户级条目不会写回。

### 会话 / Transcript（Layer 3 — 有损可读）

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| Agent transcripts | `~/.cursor/projects/<slug>/agent-transcripts/<session-id>/<session-id>.jsonl` | ⚠️ 解析 JSONL。工具结果截断，附件省略，未知字段进 `dropped_fields` |
| 子代理 | `…/subagents/*.jsonl` | ⚠️ 体积允许时附在主会话后，否则记 `transcript.subagents_omitted` |
| Chat metadata | `~/.cursor/chats/<workspace-hash>/<session-id>/store.db` | ❌ 不解析数据库 |
| 明文导出 | `--session` 指向的 `.md` / `.txt` / `.json` / `.jsonl` | ✅ 有损。Web 只接受项目目录之内的路径 |

`slug` 通常由工作区路径编码（`/` → `-`），**无官方稳定 API**，跨机器可能对不上。

---

## Trae（字节跳动 Trae IDE / AI coding agent）

官方文档：[Rules](https://docs.trae.ai/ide/rules) · [Skills](https://docs.trae.ai/ide/skills) · [MCP](https://docs.trae.ai/ide/add-mcp-servers)

### 项目级（Layer 0 — 已扫描）

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| AGENTS.md | 根目录与子目录 | ✅ 会写入；**需** Settings → Rules & Memories → **Include AGENTS.md in the context**。嵌套文件另记 `trae.agents_md.nested_toggle` |
| CLAUDE.md | `CLAUDE.md` / `CLAUDE.local.md` | ✅ 同上，需 Import 开关 |
| Project rules | `.trae/rules/**/*.md` | ✅ frontmatter：`alwaysApply` / `description` / `globs`；`scene` 保留 |
| Module rules | 任意子目录下的 `.trae/rules/` | ✅ 按 `source_path` 写回原模块，或映射到对应的 `.cursor/rules` |
| Skills | `.trae/skills/<name>/SKILL.md`；`.agents/skills/` | ✅ 文本。共享目录写到目标端 skills 目录 |
| MCP | `.trae/mcp.json` | ✅；**需** Settings → **Enable Project MCP** |

JSON 数组或 YAML 列表形式的 `globs` 写入 Trae 时会收成逗号分隔字符串，并记 `trae.rules.globs_normalized`。

### 用户级（`--include-user`）

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| Global rules | `~/.trae/user_rules`（文件或目录） | ⚠️ 文件按原文复制（格式因环境而异，不擅自加 frontmatter）。目录按 markdown 规则读写 |
| Global skills | `~/.trae/skills/` | ✅ |
| User MCP / Memories | Settings UI，**无稳定文件** | ❌ 记 `trae.user_mcp.unavailable`。不读加密库 |

### 会话 / Transcript（Layer 3 — 只读明文）

社区与逆向资料（**非官方**，需自行验证）：

| 变体 | 典型路径 | 说明 |
|------|----------|------|
| Trae CN IDE | macOS: `~/Library/Application Support/Trae CN/ModularData/ai-agent/database.db`；Windows: `%APPDATA%\Trae CN\ModularData\ai-agent\database.db` | SQLCipher 加密，与工作区绑定 |
| Trae SOLO / Work | `%APPDATA%\TRAE SOLO CN\ModularData\ai-agent\database.db` 等 | 与 IDE 库 **互不相通** |
| 国际版 | 可能为 `…/Trae/…`（无 CN 后缀） | **未在本环境实测** → open question |

**结论**：把 IDE 的 **Export Chat** 明文放到 `.acb/imports/transcript.md`（或 `.trae/exports/`，或用 `--session` 指向该文件）。`database.db` 及任何 SQLite / ModularData 路径都不会打开。导入聊天界面同样不做；确认之后只写 `.acb/TRANSCRIPT.md`。

---

## Cursor ↔ Trae 映射速查

| Bundle 字段 | Cursor 写出 | Trae 写出 |
|-------------|-------------|-----------|
| `agents_md` | 根 `AGENTS.md`，嵌套文件按 `source_path` | 同左 + 提示开开关 |
| `rules` | `<module>/.cursor/rules/*.mdc` | `<module>/.trae/rules/*.md` |
| `skills` | `<module>/.cursor/skills/<n>/SKILL.md` | `<module>/.trae/skills/<n>/SKILL.md` |
| `mcp_servers` | `.cursor/mcp.json` | `.trae/mcp.json` + 提示 Enable Project MCP |
| `work_state` | `.acb/WORK_STATE.md` sidecar | 同左 |
| `transcript` | 留在 bundle；确认后写 `.acb/TRANSCRIPT.md`。不注入 UI，不写数据库 | 同左 |

---

## Open questions（待核实）

1. Trae **国际版** vs **CN** 的 Application Support 目录准确名称是否随版本变化。
2. `~/.trae/user_rules` 是单文件还是多 markdown 文件（环境差异）。
3. ~~嵌套扫描策略~~ 已对齐：两边都扫描嵌套 `AGENTS.md` 与模块 rules，并用 `source_path` 映射。
4. 项目级 MCP `env` 仍原样保留（记入 loss_report）。用户级已脱敏。更细的 redaction profile 仍是后续议题。
