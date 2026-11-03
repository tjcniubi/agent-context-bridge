# Agent Context Bridge (`acb`)

跨 Agent 产品迁移上下文的开源 CLI：通过中立中间格式 **Agent Work Bundle**，在 Cursor、Trae 等 AI Coding Agent 之间搬运仓库级配置、工作状态摘要，以及（有损的）对话记录。

> **English:** A CLI that moves agent context between products via a neutral bundle. First adapters: **Cursor** ↔ **Trae**. Differentiator vs config-only tools (e.g. [AgentMove](https://github.com/wookat/agentmove)): first-class **Work State** + honest **`loss_report`**.

## 三层能力

| Layer | 内容 | MVP 状态 |
|-------|------|----------|
| 0 | 仓库级持久上下文：`AGENTS.md`、rules、skills、MCP | ✅ 骨架可用 |
| 1 | 会话摘要 / 决策日志（Agent Work State） | 📝 协议 + sidecar；自动摘要待做 |
| 2/3 | 有损完整对话迁移 | 📝 协议字段；适配器 stub + loss_report |

## 快速开始

```bash
cd agent-context-bridge
npm install
npm run build

# 校验示例 bundle
node dist/index.js validate examples/sample.bundle.json

# 从 Cursor 项目导出
node dist/index.js export -a cursor -p /path/to/project -o out.bundle.json

# 导入到 Trae 布局（可先 --dry-run）
node dist/index.js import -a trae -p /path/to/project -f out.bundle.json --dry-run

# 同仓库 Cursor → Trae 一键转换
node dist/index.js convert --from cursor --to trae -p /path/to/project -o bridge.bundle.json
```

开发时也可：`npm run dev -- validate examples/sample.bundle.json`

## CLI

| 命令 | 作用 |
|------|------|
| `acb validate <file>` | 按 v0.1 Zod/Schema 校验 bundle |
| `acb export -a <cursor\|trae> -p <dir> -o <file>` | 导出 repo context |
| `acb import -a <…> -p <dir> -f <file>` | 写入目标端目录布局 |
| `acb convert --from … --to … -p <dir>` | 导出再导入 |
| `acb adapters` | 列出适配器与路径 |

## 协议

- 说明：[`docs/protocol.md`](docs/protocol.md)
- JSON Schema：[`schemas/agent-work-bundle.v0.1.schema.json`](schemas/agent-work-bundle.v0.1.schema.json)
- 适配器路径与有损边界：[`docs/adapters.md`](docs/adapters.md)
- 示例：[`examples/sample.bundle.json`](examples/sample.bundle.json)
- 路线图：[`ROADMAP.md`](ROADMAP.md)

### Bundle 概要

```text
manifest      version / source_agent / target_agent / created_at / loss_report[]
repo_context  agents_md / rules[] / skills[] / mcp_servers[] / instructions_files[]
work_state    goal / decisions[] / open_loops[] / file_anchors[] / constraints[] / known_pitfalls[] / last_summary
transcript?   messages[]（可选，有损）
```

导入 Work State 时，若目标端无原生文件，会写入 `.acb/WORK_STATE.md` 供手动 `@`。

## 与 AgentMove 的关系

[AgentMove](https://github.com/wookat/agentmove) 已覆盖大量客户端的 **配置 / MCP / skills** 搬家。本项目不重复做「40+ 客户端配置同步」；而是定义可扩展的 **Work Bundle**，并把 **决策日志 / 开放环 / 损失报告** 做成一等能力。配置层可与 AgentMove 互补。

## 技术栈

- TypeScript · Node 20+ · ESM
- `commander` CLI · `zod` 运行时校验
- License: MIT

## 安全提示

Bundle 中的 MCP `env` 在 v0.1 **不会**自动脱敏。不要把含密钥的 bundle 提交到公开仓库。

## 贡献 / 下一步

见 [`ROADMAP.md`](ROADMAP.md)。建议下一编码步：补全嵌套 rules/AGENTS 扫描，并实现 `acb summarize`（Layer 1）。
