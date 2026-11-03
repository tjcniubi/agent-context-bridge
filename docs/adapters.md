# Adapters: Cursor & Trae

本文记录 **已核实** 的路径与「可迁 / 有损」边界，供实现与诚实 `loss_report` 使用。调研日期：2026-11（Asia/Shanghai）。

配置-only 多客户端搬家也可参考 [AgentMove](https://github.com/wookat/agentmove)；本项目焦点是 **Work Bundle + Work State**，第一批适配器仅为 Cursor 与 Trae。

---

## Cursor

官方文档：[Rules](https://cursor.com/docs/rules) · [MCP](https://cursor.com/docs/mcp)

### 项目级（Layer 0 — 已实现骨架）

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| AGENTS.md | `AGENTS.md`（及子目录嵌套） | ✅ 全文；嵌套子目录 AGENTS 在 v0.1 仅扫根文件 |
| Project rules | `.cursor/rules/**/*.mdc` | ✅；纯 `.md` 会被 Cursor **忽略**，导入时需补 frontmatter 并改为 `.mdc` |
| Skills | `.cursor/skills/<name>/SKILL.md`；亦发现 `.agents/skills/` | ✅ 文本；二进制 extras 有损 |
| MCP | `.cursor/mcp.json` → `mcpServers` | ✅ 便携子集；`${env:…}` 等插值保留字面量 |

### 用户级（可选，`--include-user`，v0.1 stub）

| 资源 | 路径 |
|------|------|
| MCP | `~/.cursor/mcp.json` |
| Skills | `~/.cursor/skills/` |
| Rules | `~/.cursor/rules/` |
| User Rules（账号同步） | 应用内，**无稳定可提交文件** → 有损 |

### 会话 / Transcript（Layer 3 — stub）

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| Agent transcripts | `~/.cursor/projects/<slug>/agent-transcripts/<session-id>/<session-id>.jsonl` | ⚠️ 可读 JSONL；工具结果/附件常缺失 → **有损** |
| Chat metadata | `~/.cursor/chats/<workspace-hash>/<session-id>/store.db` | ⚠️ SQLite；v0.1 不解析 |
| Subagents | `…/agent-transcripts/<id>/subagents/*.jsonl` | ⚠️ 有损 |

`slug` 通常由工作区路径编码（`/` → `-`），**无官方稳定 API**，跨机器可能对不上。

---

## Trae（字节跳动 Trae IDE / AI coding agent）

官方文档：[Rules](https://docs.trae.ai/ide/rules) · [Skills](https://docs.trae.ai/ide/skills) · [MCP](https://docs.trae.ai/ide/add-mcp-servers)

### 项目级（Layer 0 — 已实现骨架）

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| AGENTS.md | 项目根 `AGENTS.md` | ✅ 文件可拷；**需** Settings → Rules & Memories → **Include AGENTS.md in the context** |
| CLAUDE.md | `CLAUDE.md` / `CLAUDE.local.md` | ✅ 同上，需 Import 开关 |
| Project rules | `.trae/rules/**/*.md`（最多约 3 层嵌套） | ✅ frontmatter：`alwaysApply` / `description` / `globs`；另有 `scene: git_message` |
| Module rules | 任意子目录下的 `.trae/rules/` | ⚠️ 文档支持；**v0.1 未扫描**（记入 loss_report） |
| Skills | `.trae/skills/<name>/SKILL.md`；`.agents/skills/`（需启用开关） | ✅ |
| MCP | `.trae/mcp.json` | ✅；**需** Settings → **Enable Project MCP** |

### 用户级

| 资源 | 路径 | 可迁性 |
|------|------|--------|
| Global rules | `~/.trae/user_rules`（macOS/Linux）；`%userprofile%\.trae\user_rules`（Windows） | ⚠️ 目录已核实；格式细节因环境可能为文件或目录 |
| Global skills | `~/.trae/skills/` | ✅ |
| User MCP / Memories | Settings UI，**无完整公开文件格式** | ❌ / 有损（与 AgentMove 描述一致） |

### 会话 / Transcript（Layer 3 — 基本不可自动迁）

社区与逆向资料（**非官方**，需自行验证）：

| 变体 | 典型路径 | 说明 |
|------|----------|------|
| Trae CN IDE | macOS: `~/Library/Application Support/Trae CN/ModularData/ai-agent/database.db`；Windows: `%APPDATA%\Trae CN\ModularData\ai-agent\database.db` | SQLCipher 加密，与工作区绑定 |
| Trae SOLO / Work | `%APPDATA%\TRAE SOLO CN\ModularData\ai-agent\database.db` 等 | 与 IDE 库 **互不相通** |
| 国际版 | 可能为 `…/Trae/…`（无 CN 后缀） | **未在本环境实测** → open question |

**结论**：Layer 3 对 Trae 优先建议用户使用 IDE 自带 **Export Chat**；自动化解密不在本项目范围（且涉及破解类风险，不做）。

---

## Cursor ↔ Trae 映射速查

| Bundle 字段 | Cursor 写出 | Trae 写出 |
|-------------|-------------|-----------|
| `agents_md` | `AGENTS.md` | `AGENTS.md` + 提示开开关 |
| `rules` | `.cursor/rules/*.mdc` | `.trae/rules/*.md`（扩展名归一化） |
| `skills` | `.cursor/skills/<n>/SKILL.md` | `.trae/skills/<n>/SKILL.md` |
| `mcp_servers` | `.cursor/mcp.json` | `.trae/mcp.json` + 提示 Enable Project MCP |
| `work_state` | `.acb/WORK_STATE.md` sidecar | 同左 |
| `transcript` | 不注入 UI；仅留在 bundle | 同左（加密库不可写） |

---

## Open questions（待核实）

1. Trae **国际版** vs **CN** 的 Application Support 目录准确名称是否随版本变化。
2. `~/.trae/user_rules` 是单文件还是多 markdown 文件（环境差异）。
3. Cursor nested `AGENTS.md` 与 Trae 子目录 `AGENTS.md` 的优先级是否应对齐扫描策略。
4. 双方 MCP `env` 密钥的默认 redaction 策略（v0.2 议题）。
