# Agent Context Bridge (`acb`)

跨 Agent 产品接续工作的开源 CLI。中立中间格式 **Agent Work Bundle** 把「换工具之后还要接着干」从目录拷贝里拆出来：先保住工作状态，再写明哪些内容迁不过去。

第一批适配器是 **Cursor ↔ Trae**。仓库级配置（`AGENTS.md`、rules、skills、MCP）会跟着走，但它是支撑层，不是这个项目的主旨。

> **English:** A CLI and local web UI that carry work across AI coding agents through a neutral Agent Work Bundle. Cursor ↔ Trae come first. The point is Work State plus an honest `loss_report`, not a bigger config copier. `acb summarize` fills Work State from readable session text. Transcripts are a separate lossy layer: Cursor JSONL and Trae plaintext exports can be read, the encrypted Trae database is never opened, and a sidecar is written only after you confirm. The local page can pick a project folder or bundle file. Repair drafts and transcript sidecars are written only after you confirm.

## 为什么存在

换一个 Agent 产品时，常见的开源搬家工具复制的是配置：规则文件、skills、MCP。换完之后，当前目标、已经拍板的决定、没做完的事、关键文件和踩过的坑并不会跟着走。聊天记录要么整段丢失，要么被假装「完整迁移」。

本项目把这些工作事实做成协议里的一等字段，并要求每次导出和导入都留下诚实的损失清单。配置仍然迁移，用来让规则和工具在新环境里可用；接续工作靠的是 Work State。

## 特别在哪

- **中立 Agent Work Bundle。** v0.1 是一份不绑定某一家目录布局的 JSON 协议（JSON Schema + Zod）。适配器只负责读写本机路径，bundle 本身可以校验、存档、再交给另一个适配器。
- **Work State 是主字段。** `goal`、`decisions`、`open_loops`、`file_anchors`、`constraints`、`known_pitfalls`，外加可粘贴的 `last_summary`。目标端没有原生工作状态文件时，导入会写成 `.acb/WORK_STATE.md`，方便手动 `@`。
- **诚实的 `loss_report`。** 扩展名被改写、frontmatter 被补上、用户级配置没扫到、对话没写进聊天界面，都会留下 `code` / `message` / `severity`。约定是禁止静默丢弃。
- **有损但可用的 transcript 层。** 协议里的 `transcript` 是可选的：消息可以标出 `dropped_fields`，附件默认不内嵌。Cursor 的 JSONL 和 Trae 的明文导出可以读进 bundle。人仍然能读这份有损记录。它**不会**注入任何聊天界面，也**不会**解密 Trae 的本地库。
- **Cursor ↔ Trae 先行。** 项目级 rules、skills、MCP、`AGENTS.md` 会按对方的目录布局改写：扩展名（`.md` ↔ `.mdc`）、frontmatter、子目录规则都会映射，并在 `loss_report` 里写明改了什么。更多产品以后走同一份 bundle。
- **配置迁移是配角。** Layer 0 让仓库里的持久上下文能落到对方的目录布局。它不追求「覆盖尽可能多的客户端」，也不把配置同步当作主要卖点。

## 现在做到哪一步

| Layer | 内容 | v0.1 状态 |
|-------|------|-----------|
| 0 | 仓库级持久上下文：`AGENTS.md`、rules、skills、MCP | 会扫描嵌套 `AGENTS.md`、`.cursor/rules` 与子目录 `.trae/rules`，并在 Cursor 与 Trae 之间按来源路径映射。`--include-user` 读写 `~/.cursor` 与 `~/.trae/skills`、`~/.trae/user_rules`。用户级 MCP `env` / headers 导出时脱敏；项目级 `env` 保留，并写入 `loss_report`。账号同步的用户规则和 Trae 用户级 MCP 没有稳定文件，只会记损失 |
| 1 | Work State（目标、决策、开放环、文件锚点、约束、已知坑） | `acb summarize` 可用。它从 Cursor JSONL、笔记或明文导出做规则抽取，并写 `loss_report`。`export` 本身仍写出空的 `work_state` 和 `work_state.not_inferred`。Trae 加密聊天库不读取。修复向导和摘要预览都要确认之后才写入 |
| 2/3 | 有损对话 | Cursor JSONL（`agent-transcripts`）和 Trae 明文导出（`.acb/imports/`、`.trae/exports/`，或 `--session` 指向的文本文件）可以进入 `transcript`。工具结果会截断，附件不内嵌，超限会截断并记 `transcript.truncated`。Trae 加密库不读取。导入默认不落盘；`acb transcript import --apply` 或 Web 确认后才写 `.acb/TRANSCRIPT.md`。`summarize` 只抽 Work State，不负责写入 `transcript` |

本地 Web 已能完成导出、导入、转换、会话摘要预览和 transcript 预览，并按 `loss_report` 做确认式修复。`export` 仍然不会从会话自动摘要，需要单独跑 `acb summarize` 或页面上的「生成摘要预览」。

即将做的事（尚未实现）：可选的外部模型起草。详见 [`ROADMAP.md`](ROADMAP.md)。

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

# 同仓库 Cursor → Trae 一键转换，并带上有损 transcript
node dist/index.js convert --from cursor --to trae -p /path/to/project -o bridge.bundle.json --with-transcript

# 只导出 / 预览 transcript。--apply 才写入 .acb/TRANSCRIPT.md
node dist/index.js transcript export -a cursor -p /path/to/project -o out.bundle.json
node dist/index.js transcript import -p /path/to/project -f out.bundle.json
node dist/index.js transcript import -p /path/to/project -f out.bundle.json --apply

# 从笔记或 Cursor 会话填充 Work State（不写文件，直到给出 -o）
node dist/index.js summarize -p /path/to/project --notes notes.md
node dist/index.js summarize -p /path/to/project -o out.bundle.json

# 本地 Web（构建页面并监听 127.0.0.1:4173）
npm run web
```

开发时也可：`npm run dev -- validate examples/sample.bundle.json`。前端热更新用 `npm run web:dev`。

需要 Node.js 20+。构建后 bin 名为 `acb` 与 `agent-context-bridge`（入口都是 `dist/index.js`）。

## CLI

| 命令 | 作用 |
|------|------|
| `acb validate <file>` | 按 v0.1 Zod/Schema 校验 bundle |
| `acb export -a <cursor\|trae> -p <dir> -o <file>` | 导出仓库级上下文。`--include-user` 读取用户目录。`--include-transcript` / `--with-transcript` 读取有损 transcript。`--session` 指定会话 id 或明文文件。Work State 仍是空的，记 `work_state.not_inferred` |
| `acb summarize` | 从 Cursor JSONL、`--notes` 或 `--transcript` 填充 Work State，并写诚实的 `loss_report`。默认只预览；`-o` 才写入 bundle。不把完整对话写进 `transcript` |
| `acb import -a <…> -p <dir> -f <file>` | 写入目标端目录布局。已有 Work State 时附带 `.acb/WORK_STATE.md`。`--apply-transcript` 才写 `.acb/TRANSCRIPT.md`。`--include-user` 才写用户目录。`--dry-run` 列出 create / update / unchanged |
| `acb convert --from … --to … -p <dir>` | 先导出再导入。`-o` / `--out-bundle` 保留中间 bundle。`--with-transcript` 把 transcript 放进 bundle。`--apply-transcript` 同时写 sidecar。`--dry-run` 仍会导出，导入只预演 |
| `acb transcript export` | 同 export，但总是尝试读取 transcript |
| `acb transcript import` | 先打印预览。`--apply` 才写 `.acb/TRANSCRIPT.md`，不改聊天界面 |
| `acb adapters` | 列出适配器与项目级路径 |
| `acb web` | 启动本地 Web。`--port` 默认 `4173`，`--host` 默认 `127.0.0.1`。`--dev` 改用 Vite 开发服务 |

`--include-user` 会读 `~/.cursor/mcp.json`、`~/.cursor/skills`、`~/.cursor/rules`，以及 `~/.trae/skills`、`~/.trae/user_rules`。用户级 MCP 的 `env` 和 headers 会写成 `${REDACTED}`。指向家目录之外的符号链接会跳过。Cursor 账号里的 User Rules、Trae 的用户级 MCP，都没有稳定文件，只记入 `loss_report`。

`--transcript-max-bytes` 默认 `1500000`，`--transcript-max-messages` 默认 `400`。超出部分截断并记入 `loss_report`。

## 本地 Web

`npm run web` 会先构建页面，再启动本地服务。CLI（`npm run build`）和前端（`npm run build:web`）都构建过之后，也可以 `node dist/index.js web`。服务默认只绑定本机回环地址，读写的是你本机上的项目路径。

页面和 CLI 共用同一套适配器、Zod 校验和 Work State Markdown。

1. 粘贴项目路径，或用「选择项目文件夹」。浏览器选中的文件夹没有绝对路径，本机服务会按目录名和其中的文件定位；对不上时仍用路径框或「服务器目录」。bundle 用「选择 bundle 文件」读取内容。
2. 在 Cursor 与 Trae 之间导出、导入或转换，并查看 `loss_report`。可以勾选用户级配置和有损 transcript。勾选预演时，导入不写项目文件，并标出 create / update / unchanged。
3. 「生成摘要预览」从可读会话或笔记抽出 Work State。预览可以改，确认后才进入当前 bundle。加密的 Trae 聊天库不会读取。
4. 如果 bundle 里有 transcript，页面会预览角色、正文和 `dropped_fields`。确认之后才写入 `.acb/TRANSCRIPT.md`。这一步不改聊天界面。
5. 开始逐条修复。向导按损失项提问，根据回答起草 Work State。
6. 每一条草案都要确认或拒绝之后才写入。也可以一次确认或拒绝全部待定草案。对话里输入「确认」「拒绝」「修改」「全部确认」「全部拒绝」，效果和按钮相同。
7. 下载更新后的 bundle，或把已确认的内容写到项目里的 `.acb/WORK_STATE.md`。

未确认的草案不会进入 bundle，也不会写进项目。拒绝和确认跳过都会留在 `loss_report` 里（`repair.declined` / `repair.skipped`）；确认写入记为 `repair.applied`。transcript sidecar 同样要单独确认。

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

用户级 MCP 的 `env` 和 headers 在 `--include-user` 导出时会脱敏。项目级 MCP `env` 仍会原样留在 bundle 里，并写入 `loss_report`。不要把含密钥的 bundle 提交到公开仓库。

## 贡献 / 下一步

见 [`ROADMAP.md`](ROADMAP.md)。仓库级配置、`acb summarize` 和有损 transcript 都已经可用。确认之后才写入的门槛保持不变。下一步是可选的外部模型起草。
