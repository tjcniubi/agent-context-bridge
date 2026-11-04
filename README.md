# Agent Context Bridge (`acb`)

跨 Agent 产品接续工作的开源 CLI。中立中间格式 **Agent Work Bundle** 把「换工具之后还要接着干」从目录拷贝里拆出来：先保住工作状态，再写明哪些内容迁不过去。

第一批适配器是 **Cursor ↔ Trae**。仓库级配置（`AGENTS.md`、rules、skills、MCP）会跟着走，但它是支撑层，不是这个项目的主旨。

> **English:** A CLI and local web UI that carry work across AI coding agents through a neutral Agent Work Bundle. Cursor ↔ Trae come first. The point is Work State plus an honest `loss_report`, not a bigger config copier. Transcripts are modeled as lossy but still readable. The web repair guide drafts Work State and writes it only after you confirm.

## 为什么存在

换一个 Agent 产品时，常见的开源搬家工具复制的是配置：规则文件、skills、MCP。换完之后，当前目标、已经拍板的决定、没做完的事、关键文件和踩过的坑并不会跟着走。聊天记录要么整段丢失，要么被假装「完整迁移」。

本项目把这些工作事实做成协议里的一等字段，并要求每次导出和导入都留下诚实的损失清单。配置仍然迁移，用来让规则和工具在新环境里可用；接续工作靠的是 Work State。

## 特别在哪

- **中立 Agent Work Bundle。** v0.1 是一份不绑定某一家目录布局的 JSON 协议（JSON Schema + Zod）。适配器只负责读写本机路径，bundle 本身可以校验、存档、再交给另一个适配器。
- **Work State 是主字段。** `goal`、`decisions`、`open_loops`、`file_anchors`、`constraints`、`known_pitfalls`，外加可粘贴的 `last_summary`。目标端没有原生工作状态文件时，导入会写成 `.acb/WORK_STATE.md`，方便手动 `@`。
- **诚实的 `loss_report`。** 扩展名被改写、frontmatter 被补上、用户级配置没扫到、对话没写进聊天界面，都会留下 `code` / `message` / `severity`。约定是禁止静默丢弃。
- **有损但可用的 transcript 层。** 协议里的 `transcript` 是可选的：消息可以标出 `dropped_fields`，附件默认不内嵌。人仍然能读这份有损记录。v0.1 **不会**把对话注入 Cursor 或 Trae 的聊天界面，也不会解密 Trae 的本地库。
- **Cursor ↔ Trae 先行。** 项目级 rules、skills、MCP、`AGENTS.md` 已有导出 / 导入 / 转换骨架，并做扩展名归一化（例如 Trae 的 `.md` 规则写入 Cursor 时改为 `.mdc`）。更多产品以后走同一份 bundle。
- **配置迁移是配角。** Layer 0 让仓库里的持久上下文能落到对方的目录布局。它不追求「覆盖尽可能多的客户端」，也不把配置同步当作主要卖点。

## 现在做到哪一步

| Layer | 内容 | v0.1 状态 |
|-------|------|-----------|
| 0 | 仓库级持久上下文：`AGENTS.md`、rules、skills、MCP | 项目级骨架可用。嵌套 `AGENTS.md`、子目录 rules、以及 `--include-user` 的用户级配置尚未扫全，缺口写入 `loss_report` |
| 1 | Work State（目标、决策、开放环、文件锚点、约束、已知坑） | 协议字段和导入 sidecar（`.acb/WORK_STATE.md`）可用。`export` 不会从会话自动摘要，会写出空的 `work_state` 并记录 `work_state.not_inferred`。手写或示例 bundle 可以带上完整状态 |
| 2/3 | 有损对话 | 协议字段可用（见示例 bundle）。适配器是 stub：`--session` 只记损失，不解析 Cursor JSONL，也不写入 Trae 加密库 |

本地 Web 已能完成导出、导入、转换，并按 `loss_report` 做确认式修复。`export` 仍然不会从会话自动摘要。

即将做的事（尚未实现）：`acb summarize`、嵌套规则扫描、真正的用户级配置读写、MCP `env` 脱敏、从 Cursor JSONL 抽出 transcript。详见 [`ROADMAP.md`](ROADMAP.md)。

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

# 本地 Web（构建页面并监听 127.0.0.1:4173）
npm run web
```

开发时也可：`npm run dev -- validate examples/sample.bundle.json`。前端热更新用 `npm run web:dev`。

需要 Node.js 20+。构建后 bin 名为 `acb` 与 `agent-context-bridge`（入口都是 `dist/index.js`）。

## CLI

| 命令 | 作用 |
|------|------|
| `acb validate <file>` | 按 v0.1 Zod/Schema 校验 bundle |
| `acb export -a <cursor\|trae> -p <dir> -o <file>` | 导出项目级 repo context。Work State 与 transcript 在 v0.1 不会自动填充 |
| `acb import -a <…> -p <dir> -f <file>` | 写入目标端目录布局；已有 Work State 时附带 `.acb/WORK_STATE.md` |
| `acb convert --from … --to … -p <dir>` | 先导出再导入。`-o` / `--out-bundle` 保留中间 bundle。`--dry-run` 仍会导出，导入只预演 |
| `acb adapters` | 列出适配器与项目级路径 |
| `acb web` | 启动本地 Web。`--port` 默认 `4173`，`--host` 默认 `127.0.0.1`。`--dev` 改用 Vite 开发服务 |

`--include-user` 已挂在 `export` / `convert` 上，v0.1 只记录「用户级尚未实现」，不会读写 `~/.cursor` 或 `~/.trae`。

## 本地 Web

`npm run web` 会先构建页面，再启动本地服务。CLI（`npm run build`）和前端（`npm run build:web`）都构建过之后，也可以 `node dist/index.js web`。服务默认只绑定本机回环地址，读写的是你本机上的项目路径。

页面和 CLI 共用同一套适配器、Zod 校验和 Work State Markdown。

1. 填写项目路径，或上传一份 bundle。
2. 在 Cursor 与 Trae 之间导出、导入或转换，并查看 `loss_report`。勾选预演时，导入不写项目文件。
3. 开始逐条修复。向导按损失项提问，根据回答起草 Work State。
4. 每一条草案都要确认或拒绝之后才写入。也可以一次确认或拒绝全部待定草案。对话里输入「确认」「拒绝」「修改」「全部确认」「全部拒绝」，效果和按钮相同。
5. 下载更新后的 bundle，或把已确认的内容写到项目里的 `.acb/WORK_STATE.md`。

未确认的草案不会进入 bundle，也不会写进项目。拒绝和确认跳过都会留在 `loss_report` 里（`repair.declined` / `repair.skipped`）；确认写入记为 `repair.applied`。

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
transcript?   messages[]（可选；可标 dropped_fields，附件默认不内嵌）
```

## 技术栈

- TypeScript · Node 20+ · ESM
- `commander` CLI · `zod` 运行时校验
- Vite 本地 Web（`npm run web`）
- License: MIT

## 安全提示

Bundle 中的 MCP `env` 在 v0.1 **不会**自动脱敏。不要把含密钥的 bundle 提交到公开仓库。

## 贡献 / 下一步

见 [`ROADMAP.md`](ROADMAP.md)。本地 Web 与确认式修复已经可用。建议的下一编码步：补全嵌套 rules / `AGENTS.md` 扫描，并实现 `acb summarize`（Layer 1）。
