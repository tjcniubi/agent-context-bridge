# ROADMAP

## MVP 顺序

1. **Protocol v0.1** ✅  
   Agent Work Bundle JSON Schema + Zod + `docs/protocol.md` + `validate`

2. **Repo config Cursor ↔ Trae** ✅  
   - [x] 路径映射与 export/import 骨架、扩展名归一化、loss_report  
   - [x] 嵌套 AGENTS.md / 子目录 `.trae/rules`（以及嵌套 `.cursor/rules`）完整扫描，并按来源路径映射到目标布局  
   - [x] `--include-user` 读写 `~/.cursor/*` 与 `~/.trae/skills|user_rules`；越界符号链接跳过；没有稳定文件的用户规则只记损失  
   - [x] 用户级 MCP env / headers 脱敏；项目级 env 保留并写入 loss_report。dry-run 列出 create / update / unchanged

3. **work_state summarize** ✅  
   - [x] `acb summarize`：最近的 Cursor JSONL，或笔记 / 明文导出 → goal、decisions、open_loops、file_anchors、constraints、known_pitfalls、last_summary，并写 `loss_report`  
   - [x] Trae 加密库不读取；发现 `database.db` 只记 `transcript.trae_encrypted`。明文用 `--transcript` 或 `--notes`  
   - [x] 导入时只要 `work_state` 非空就生成 `.acb/WORK_STATE.md`  
   - [x] 本地 Web：生成摘要预览，可编辑，确认后才写入 bundle  
   - [x] 用模型提高摘要质量（可选，仍须输出 `loss_report`）。`acb summarize --model` 调用 OpenAI 兼容接口；失败回退规则抽取，并记 `work_state.model_drafted` / `work_state.model_failed`

4. **Lossy transcript** ✅  
   - [x] Cursor：解析 `agent-transcripts/**/*.jsonl` → `transcript`（标记 dropped_fields；子代理在体积允许时附上）。`summarize` 只用文本抽 Work State，不负责写入 `transcript`  
   - [x] Trae：读取 Export Chat / `.acb/imports` / `.trae/exports` 明文；加密库不打开，只记 loss  
   - [x] `export` / `convert --with-transcript`、体积限制，以及 `acb transcript export|import`  
   - [x] Web 预览 transcript；确认之后才写 `.acb/TRANSCRIPT.md`，不注入聊天界面

5. **本地 Web 与交互式修复** ✅  
   - [x] `npm run web` / `acb web`，默认只监听 `127.0.0.1`  
   - [x] 项目路径可手填，也可用系统文件夹选择器；bundle 可用系统文件选择器  
   - [x] Cursor ↔ Trae 导出 / 导入 / 转换，并展示 `loss_report`  
   - [x] 修复向导逐条提问并起草 Work State；单条或批量确认 / 拒绝之后才写入  
   - [x] 会话摘要预览，确认后才写入 Work State  
   - [x] 可选外部模型起草（摘要预览和修复向导共用本机环境变量）；确认之后才写入的门槛保持不变

## 之后

- 更多适配器（Codex、Claude Code…）——仍走同一 Bundle  
- Schema `0.2`：attachments 外置、redaction profile  
- 发布 npm 包 `agent-context-bridge`
