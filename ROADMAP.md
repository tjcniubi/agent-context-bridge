# ROADMAP

## MVP 顺序

1. **Protocol v0.1** ✅  
   Agent Work Bundle JSON Schema + Zod + `docs/protocol.md` + `validate`

2. **Repo config Cursor ↔ Trae** ✅ scaffold / 🔄 deepen  
   - [x] 路径映射与 export/import 骨架、扩展名归一化、loss_report  
   - [ ] 嵌套 AGENTS.md / 子目录 `.trae/rules` 完整扫描  
   - [ ] `--include-user` 真正读写 `~/.cursor/*` 与 `~/.trae/skills|user_rules`  
   - [ ] MCP env 脱敏与 dry-run diff

3. **work_state summarize**  
   - [ ] `acb summarize`：从最近 Cursor JSONL（或粘贴的笔记）抽出 goal / decisions / open_loops  
   - [ ] 导入时默认生成高质量 `.acb/WORK_STATE.md`  
   - [ ] 可选：写入目标端可 `@` 的固定文件名约定

4. **Lossy transcript**  
   - [ ] Cursor：解析 `agent-transcripts/**/*.jsonl` → `transcript`（标记 dropped_fields）  
   - [ ] Trae：引导 Export Chat / 明确加密库不可自动导入  
   - [ ] `convert --with-transcript` 开关与体积限制

## 之后

- 更多适配器（Codex、Claude Code…）——仍走同一 Bundle  
- Schema `0.2`：attachments 外置、redaction profile  
- 发布 npm 包 `agent-context-bridge`
