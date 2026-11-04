# ROADMAP

## MVP 顺序

1. **Protocol v0.1** ✅  
   Agent Work Bundle JSON Schema + Zod + `docs/protocol.md` + `validate`

2. **Repo config Cursor ↔ Trae** ✅ scaffold / 🔄 deepen  
   - [x] 路径映射与 export/import 骨架、扩展名归一化、loss_report  
   - [ ] 嵌套 AGENTS.md / 子目录 `.trae/rules` 完整扫描  
   - [ ] `--include-user` 真正读写 `~/.cursor/*` 与 `~/.trae/skills|user_rules`  
   - [ ] MCP env 脱敏与 dry-run diff

3. **work_state summarize** ✅  
   - [x] `acb summarize`：最近的 Cursor JSONL，或笔记 / 明文导出 → goal、decisions、open_loops、file_anchors、constraints、known_pitfalls、last_summary，并写 `loss_report`  
   - [x] Trae 加密库不读取；发现 `database.db` 只记 `transcript.trae_encrypted`。明文用 `--transcript` 或 `--notes`  
   - [x] 导入时只要 `work_state` 非空就生成 `.acb/WORK_STATE.md`  
   - [x] 本地 Web：生成摘要预览，可编辑，确认后才写入 bundle  
   - [ ] 用模型提高摘要质量（可选，仍须输出 `loss_report`）

4. **Lossy transcript**  
   - [ ] Cursor：把 `agent-transcripts/**/*.jsonl` 写入 bundle `transcript`（标记 dropped_fields）。`summarize` 只用其中的文本抽 Work State，不回写 transcript  
   - [x] Trae：加密库不可自动导入；明文 Export Chat 交给 `acb summarize`  
   - [ ] `convert --with-transcript` 开关与体积限制

5. **本地 Web 与交互式修复** ✅  
   - [x] `npm run web` / `acb web`，默认只监听 `127.0.0.1`  
   - [x] 项目路径可手填，也可用系统文件夹选择器；bundle 可用系统文件选择器  
   - [x] Cursor ↔ Trae 导出 / 导入 / 转换，并展示 `loss_report`  
   - [x] 修复向导逐条提问并起草 Work State；单条或批量确认 / 拒绝之后才写入  
   - [x] 会话摘要预览，确认后才写入 Work State  
   - [ ] 可选外部模型起草；确认之后才写入的门槛保持不变

## 之后

- 更多适配器（Codex、Claude Code…）——仍走同一 Bundle  
- Schema `0.2`：attachments 外置、redaction profile  
- 发布 npm 包 `agent-context-bridge`
