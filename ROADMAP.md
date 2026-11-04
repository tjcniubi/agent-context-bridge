# ROADMAP

## MVP 顺序

1. **Protocol v0.1** ✅  
   Agent Work Bundle JSON Schema + Zod + `docs/protocol.md` + `validate`

2. **Repo config Cursor ↔ Trae** ✅  
   - [x] 路径映射与 export/import 骨架、扩展名归一化、loss_report  
   - [x] 嵌套 AGENTS.md / 子目录 `.trae/rules`（以及嵌套 `.cursor/rules`）完整扫描，并按来源路径映射到目标布局  
   - [x] `--include-user` 读写 `~/.cursor/*` 与 `~/.trae/skills|user_rules`；越界符号链接跳过；没有稳定文件的用户规则只记损失  
   - [x] 用户级 MCP env / headers 脱敏；项目级 env 保留并写入 loss_report。dry-run 列出 create / update / unchanged

3. **work_state summarize**  
   - [ ] `acb summarize`：从最近 Cursor JSONL（或粘贴的笔记）抽出 goal / decisions / open_loops  
   - [ ] 导入时默认生成高质量 `.acb/WORK_STATE.md`  
   - [ ] 可选：写入目标端可 `@` 的固定文件名约定

4. **Lossy transcript** ✅  
   - [x] Cursor：解析 `agent-transcripts/**/*.jsonl` → `transcript`（标记 dropped_fields；子代理在体积允许时附上）  
   - [x] Trae：读取 Export Chat / `.acb/imports` / `.trae/exports` 明文；加密库不打开，只记 loss  
   - [x] `export` / `convert --with-transcript`、体积限制，以及 `acb transcript export|import`  
   - [x] Web 预览 transcript；确认之后才写 `.acb/TRANSCRIPT.md`，不注入聊天界面

5. **本地 Web 与交互式修复** ✅  
   - [x] `npm run web` / `acb web`，默认只监听 `127.0.0.1`  
   - [x] 项目路径或上传 bundle；Cursor ↔ Trae 导出 / 导入 / 转换，并展示 `loss_report`  
   - [x] 修复向导逐条提问并起草 Work State；单条或批量确认 / 拒绝之后才写入  
   - [ ] 可选外部模型起草；确认之后才写入的门槛保持不变

## 之后

- 更多适配器（Codex、Claude Code…）——仍走同一 Bundle  
- Schema `0.2`：attachments 外置、redaction profile  
- 发布 npm 包 `agent-context-bridge`
