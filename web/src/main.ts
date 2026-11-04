import type { AgentWorkBundle, LossReportEntry } from "../../src/protocol/types.ts";
import { hasWorkStateContent, renderWorkStateMarkdown } from "../../src/protocol/work-state-markdown.ts";
import { api, type AdapterInfo, type BundleResponse, type RepairSessionView } from "./api.ts";
import {
  armFileInput,
  fingerprintFromFiles,
  tryNativeBundleFile,
  tryNativeDirectory,
  tryNativeTextFile,
} from "./pickers.ts";
import { buildSummaryEditor, type SummaryPreview } from "./summary-editor.ts";

interface DirListing {
  path: string;
  parent: string;
  dirs: { name: string; path: string }[];
}

interface AppState {
  busy: boolean;
  error: string;
  note: string;
  bundle: AgentWorkBundle | null;
  losses: LossReportEntry[];
  written: string[];
  dryRun: boolean;
  repair: RepairSessionView | null;
  dir: DirListing | null;
}

const state: AppState = {
  busy: false,
  error: "",
  note: "先导出、转换，或上传一份 bundle。",
  bundle: null,
  losses: [],
  written: [],
  dryRun: false,
  repair: null,
  dir: null,
};

let summaryDraft: SummaryPreview | null = null;
let attachedTranscripts: { name: string; text: string }[] = [];

const app = document.querySelector("#app");
if (!app) throw new Error("缺少 #app");

app.innerHTML = `
  <div class="app">
    <header class="top">
      <div class="brand">
        <span class="mark" aria-hidden="true"></span>
        <div>
          <p class="eyebrow">127.0.0.1 · 本地</p>
          <h1>Agent Context Bridge</h1>
        </div>
      </div>
      <p class="lede">在本机把项目或 bundle 在 Cursor 与 Trae 之间导出、导入、转换。可以用系统文件夹和文件选择器指定路径。会话摘要先出预览，确认之后才写入 Work State。</p>
    </header>
    <div id="error" class="banner error" hidden></div>
    <div class="layout">
      <section class="panel">
        <h2>来源</h2>
        <div class="stack">
          <label>项目路径
            <input id="project" type="text" placeholder="/path/to/project" autocomplete="off" />
          </label>
          <div class="actions">
            <button id="pick-dir" type="button">选择项目文件夹</button>
            <button id="browse" class="secondary" type="button">服务器目录</button>
          </div>
          <p id="pick-hint" class="hint">可以直接粘贴绝对路径。选择文件夹后，本机会按目录名和其中的文件定位路径。页面默认只监听回环地址。</p>
          <div id="pick-matches" class="match-list"></div>
          <input id="pick-dir-input" type="file" hidden />
          <div class="pair">
            <label>来源
              <select id="from-agent"></select>
            </label>
            <label>目标
              <select id="to-agent"></select>
            </label>
          </div>
          <div class="checks">
            <label><input id="dry-run" type="checkbox" /> 预演导入，不写项目文件</label>
            <label><input id="include-user" type="checkbox" /> 记录用户级配置缺口</label>
          </div>
          <label>会话 id（可选，用来标出 transcript 损失）
            <input id="session-id" type="text" placeholder="session id" />
          </label>
          <div class="actions">
            <button id="export" type="button">导出</button>
            <button id="convert" type="button">转换到目标</button>
            <button id="import" class="secondary" type="button">导入到目标</button>
          </div>
          <div class="actions">
            <button id="pick-bundle" class="secondary" type="button">选择 bundle 文件</button>
          </div>
          <input id="bundle-file" type="file" accept="application/json,.json" hidden />
        </div>
      </section>
      <section class="panel">
        <h2>结果</h2>
        <div id="secret" class="banner" hidden></div>
        <p id="note" class="meta"></p>
        <div id="stats" class="stats"></div>
        <h3>loss_report</h3>
        <ul id="losses" class="losses"></ul>
        <h3>写出的路径</h3>
        <ul id="written" class="written"></ul>
        <div class="actions">
          <button id="download" class="secondary" type="button">下载 bundle</button>
          <button id="start-repair" type="button">开始逐条修复</button>
        </div>
      </section>
    </div>
    <section class="panel summarize">
      <h2>会话摘要</h2>
      <p class="hint">从 Cursor 的可读会话、笔记，或 Trae 的明文导出抽出 Work State。加密的 Trae 聊天库不会读取。预览可以改，确认后才写入当前 bundle。</p>
      <div class="stack">
        <label>摘要来源
          <select id="summary-agent">
            <option value="both">Cursor 和 Trae</option>
            <option value="cursor">Cursor</option>
            <option value="trae">Trae</option>
          </select>
        </label>
        <label>笔记（可选，带标题时优先）
          <textarea id="summary-notes" placeholder="## 目标&#10;把规则迁过去"></textarea>
        </label>
        <div class="actions">
          <button id="pick-notes" class="secondary" type="button">选择笔记或 transcript 文件</button>
          <button id="summarize" type="button">生成摘要预览</button>
        </div>
        <p id="notes-hint" class="hint"></p>
        <input id="notes-file" type="file" accept=".md,.txt,.json,.jsonl,text/plain,application/json" hidden />
        <div id="summary-editor"></div>
      </div>
    </section>
    <section class="panel repair">
      <h2>交互式修复</h2>
      <p id="repair-progress" class="meta">确认之前，草案只停在对话里。</p>
      <div id="repair-log" class="chat" aria-live="polite"></div>
      <div id="repair-card"></div>
      <form id="repair-form" class="composer">
        <label>回答当前损失项
          <textarea id="repair-input" placeholder="写下要记住的事实。草案出现后，也可以输入「确认」「拒绝」「修改」「全部确认」或「全部拒绝」。"></textarea>
        </label>
        <button id="repair-send" type="submit">发送</button>
      </form>
      <details id="batch">
        <summary>批量起草与确认（待确认 <span id="pending-count">0</span>）</summary>
        <div id="batch-body" class="stack"></div>
      </details>
      <h3>已确认的 Work State</h3>
      <pre id="work-state" class="state"></pre>
      <div class="actions">
        <button id="write-sidecar" class="secondary" type="button">写入 .acb/WORK_STATE.md</button>
      </div>
    </section>
  </div>
  <dialog id="dir-dialog">
    <form method="dialog" class="stack">
      <h3>选择目录</h3>
      <p id="dir-path" class="mono"></p>
      <div class="actions">
        <button id="dir-up" class="secondary" type="button" value="up">上级</button>
        <button id="dir-use" type="button" value="use">使用此路径</button>
        <button class="secondary" type="submit" value="close">关闭</button>
      </div>
      <ul id="dir-list" class="dir-list"></ul>
    </form>
  </dialog>
`;

const el = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 #${id}`);
  return node as T;
};

void boot();

async function boot(): Promise<void> {
  try {
    const data = await api<{ adapters: AdapterInfo[] }>("/api/adapters");
    fillAgents(data.adapters);
  } catch (err) {
    setError(messageOf(err));
    fillAgents([
      { id: "cursor", displayName: "Cursor", project: blankPaths() },
      { id: "trae", displayName: "Trae", project: blankPaths() },
    ]);
  }
  el<HTMLInputElement>("project").value = "";
  const dirInput = el<HTMLInputElement>("pick-dir-input");
  dirInput.multiple = true;
  dirInput.setAttribute("webkitdirectory", "");
  dirInput.setAttribute("directory", "");
  bind();
  render();
}

function blankPaths(): AdapterInfo["project"] {
  return {
    agentsMd: "AGENTS.md",
    rulesDir: "",
    skillsDir: "",
    mcpJson: "",
    instructionNames: [],
  };
}

function fillAgents(adapters: AdapterInfo[]): void {
  for (const id of ["from-agent", "to-agent"]) {
    const select = el<HTMLSelectElement>(id);
    select.replaceChildren();
    for (const adapter of adapters) {
      const option = document.createElement("option");
      option.value = adapter.id;
      option.textContent = adapter.displayName;
      select.append(option);
    }
  }
  const from = el<HTMLSelectElement>("from-agent");
  const to = el<HTMLSelectElement>("to-agent");
  if ([...from.options].some((option) => option.value === "cursor")) from.value = "cursor";
  if ([...to.options].some((option) => option.value === "trae")) to.value = "trae";
}

function bind(): void {
  el<HTMLButtonElement>("browse").addEventListener("click", () => void run(() => openDir()));
  el<HTMLButtonElement>("pick-dir").addEventListener("click", () => void run(() => doPickDir()));
  el<HTMLButtonElement>("pick-bundle").addEventListener("click", () => void run(() => doPickBundle()));
  el<HTMLButtonElement>("pick-notes").addEventListener("click", () => void run(() => doPickNotes()));
  el<HTMLButtonElement>("summarize").addEventListener("click", () => void run(() => doPreview()));
  el<HTMLInputElement>("project").addEventListener("input", () => syncControls());
  el<HTMLButtonElement>("export").addEventListener("click", () => void run(() => doExport()));
  el<HTMLButtonElement>("convert").addEventListener("click", () => void run(() => doConvert()));
  el<HTMLButtonElement>("import").addEventListener("click", () => void run(() => doImport()));
  el<HTMLButtonElement>("download").addEventListener("click", () => downloadActive());
  el<HTMLButtonElement>("start-repair").addEventListener("click", () => void run(() => doStartRepair()));
  el<HTMLButtonElement>("write-sidecar").addEventListener("click", () => void run(() => doWriteSidecar()));
  el<HTMLFormElement>("repair-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(() => doAnswer());
  });
  el<HTMLButtonElement>("dir-up").addEventListener("click", () => {
    if (state.dir) void loadDir(state.dir.parent);
  });
  el<HTMLButtonElement>("dir-use").addEventListener("click", () => {
    if (!state.dir) return;
    el<HTMLInputElement>("project").value = state.dir.path;
    el<HTMLDialogElement>("dir-dialog").close();
  });
}

async function openDir(): Promise<void> {
  const current = el<HTMLInputElement>("project").value.trim();
  await loadDir(current || ".");
  el<HTMLDialogElement>("dir-dialog").showModal();
}

async function loadDir(path: string): Promise<void> {
  const listing = await api<DirListing>(`/api/fs/list?path=${encodeURIComponent(path)}`);
  state.dir = listing;
  el<HTMLElement>("dir-path").textContent = listing.path;
  const list = el<HTMLElement>("dir-list");
  list.replaceChildren();
  if (listing.dirs.length === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "没有可进入的子目录。";
    list.append(item);
    return;
  }
  for (const dir of listing.dirs) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = dir.name;
    button.addEventListener("click", () => void loadDir(dir.path).catch((err) => setError(messageOf(err))));
    item.append(button);
    list.append(item);
  }
}

async function doExport(): Promise<void> {
  const result = await api<BundleResponse>("/api/export", {
    method: "POST",
    body: {
      agent: value("from-agent"),
      project: requireProject(),
      includeUser: checked("include-user"),
      sessionId: value("session-id"),
    },
  });
  adopt(result, `已从 ${result.summary.source} 导出。`);
}

async function doConvert(): Promise<void> {
  const result = await api<BundleResponse>("/api/convert", {
    method: "POST",
    body: {
      from: value("from-agent"),
      to: value("to-agent"),
      project: requireProject(),
      dryRun: checked("dry-run"),
      includeUser: checked("include-user"),
    },
  });
  adopt(result, result.dryRun ? "转换已预演，项目文件没有改动。" : "转换完成。");
}

async function doImport(): Promise<void> {
  if (!state.bundle) throw new Error("请先导出或上传 bundle。");
  const result = await api<BundleResponse>("/api/import", {
    method: "POST",
    body: {
      agent: value("to-agent"),
      project: requireProject(),
      bundle: state.bundle,
      dryRun: checked("dry-run"),
    },
  });
  adopt(result, result.dryRun ? "导入已预演，项目文件没有改动。" : "导入完成。");
}

async function doPickDir(): Promise<void> {
  const native = await tryNativeDirectory();
  if (native === null) return;
  if (native === "fallback") {
    armFileInput(el<HTMLInputElement>("pick-dir-input"), (files) => {
      void run(async () => {
        const fingerprint = await fingerprintFromFiles(files);
        if (!fingerprint) throw new Error("没有从选择的文件夹里读到文件。");
        await locateDirectory(fingerprint);
      });
    });
    return;
  }
  await locateDirectory(native);
}

async function locateDirectory(fingerprint: {
  name: string;
  entries: string[];
  hint?: { name: string; sha256: string };
}): Promise<void> {
  const result = await api<{ matches: string[]; truncated: boolean }>("/api/fs/match", {
    method: "POST",
    body: fingerprint,
  });
  showMatches(result.matches, result.truncated);
}

function showMatches(paths: string[], truncated: boolean): void {
  const box = el<HTMLElement>("pick-matches");
  const hint = el<HTMLElement>("pick-hint");
  box.replaceChildren();
  if (paths.length === 1) {
    el<HTMLInputElement>("project").value = paths[0] ?? "";
    hint.textContent = truncated
      ? "已填入定位到的路径。搜索提前结束，如果不是这个目录，请改路径或用「服务器目录」。"
      : "已填入定位到的项目路径。";
    return;
  }
  if (paths.length === 0) {
    hint.textContent = truncated
      ? "搜索提前结束，还没有定位到这个文件夹。请粘贴路径，或用「服务器目录」。"
      : "没有在主目录附近定位到这个文件夹。请粘贴路径，或用「服务器目录」。";
    return;
  }
  hint.textContent = "找到多个同名目录，请选一个。";
  for (const path of paths) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = path;
    button.addEventListener("click", () => {
      el<HTMLInputElement>("project").value = path;
      box.replaceChildren();
      hint.textContent = "已填入项目路径。";
    });
    box.append(button);
  }
}

async function doPickBundle(): Promise<void> {
  const native = await tryNativeBundleFile();
  if (native === null) return;
  if (native === "fallback") {
    armFileInput(el<HTMLInputElement>("bundle-file"), (files) => {
      const file = files[0];
      if (file) void run(() => loadBundleFile(file));
    });
    return;
  }
  await loadBundleFile(native);
}

async function loadBundleFile(file: File): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error("选择的文件不是合法 JSON。");
  }
  const result = await api<BundleResponse & { ok: boolean }>("/api/validate", {
    method: "POST",
    body: { bundle: parsed },
  });
  adopt(result, `已载入 ${file.name}。`);
}

async function doPickNotes(): Promise<void> {
  const native = await tryNativeTextFile();
  if (native === null) return;
  if (native === "fallback") {
    armFileInput(el<HTMLInputElement>("notes-file"), (files) => {
      const file = files[0];
      if (file) void run(() => attachNotesFile(file));
    });
    return;
  }
  await attachNotesFile(native);
}

async function attachNotesFile(file: File): Promise<void> {
  let text = await file.text();
  if (text.length > 500_000) text = text.slice(0, 500_000);
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonl")) {
    attachedTranscripts = [{ name: file.name, text }];
    el<HTMLElement>("notes-hint").textContent = `已附加 transcript：${file.name}`;
    return;
  }
  const area = el<HTMLTextAreaElement>("summary-notes");
  area.value = area.value.trim() ? `${area.value.trim()}\n\n${text}` : text;
  el<HTMLElement>("notes-hint").textContent = `已把 ${file.name} 放进笔记框。`;
}

async function doPreview(): Promise<void> {
  const result = await api<SummaryPreview>("/api/summarize/preview", {
    method: "POST",
    body: {
      project: requireProject(),
      agent: value("summary-agent"),
      sessionId: value("session-id"),
      notesText: el<HTMLTextAreaElement>("summary-notes").value,
      transcriptTexts: attachedTranscripts,
      bundle: state.bundle,
    },
  });
  summaryDraft = result;
  paintSummary();
  state.note = "摘要预览已生成。确认之前，bundle 不会改。";
}

function paintSummary(): void {
  const root = el<HTMLElement>("summary-editor");
  root.replaceChildren();
  if (!summaryDraft) return;
  const draft = summaryDraft;
  root.append(
    buildSummaryEditor(draft, {
      onApply: (workState) => void run(() => doApplySummary(workState)),
      onDiscard: () => {
        summaryDraft = null;
        paintSummary();
        state.note = "已放弃摘要预览。";
        render();
      },
    }),
  );
}

async function doApplySummary(workState: SummaryPreview["workState"]): Promise<void> {
  if (!summaryDraft) throw new Error("请先生成摘要预览。");
  const result = await api<BundleResponse & { applied: boolean }>("/api/summarize/apply", {
    method: "POST",
    body: {
      bundle: state.bundle,
      workState,
      losses: summaryDraft.losses,
      project: value("project"),
      sourceAgent: summaryDraft.sourceAgent,
    },
  });
  summaryDraft = null;
  paintSummary();
  adopt(result, "已把确认后的 Work State 写入当前 bundle。项目文件还没有改。");
}

async function doStartRepair(): Promise<void> {
  if (!state.bundle) throw new Error("还没有 bundle。");
  state.repair = await api<RepairSessionView>("/api/repair/start", {
    method: "POST",
    body: { bundle: state.bundle },
  });
  state.bundle = state.repair.bundle;
  el<HTMLElement>("repair-progress").scrollIntoView({ block: "start" });
}

async function doAnswer(): Promise<void> {
  if (!state.repair) throw new Error("请先开始修复。");
  const text = el<HTMLTextAreaElement>("repair-input").value;
  if (!text.trim()) throw new Error("请先写回答。");
  state.repair = await api<RepairSessionView>(`/api/repair/${state.repair.id}/answer`, {
    method: "POST",
    body: { text },
  });
  state.bundle = state.repair.bundle;
  el<HTMLTextAreaElement>("repair-input").value = "";
}

async function doWriteSidecar(): Promise<void> {
  if (!state.bundle) throw new Error("还没有 bundle。");
  const project = requireProject();
  const ok = window.confirm(`把已确认的 Work State 写到\n${project}/.acb/WORK_STATE.md ？`);
  if (!ok) return;
  const result = await api<{ written: string }>("/api/work-state/write", {
    method: "POST",
    body: { project, bundle: activeBundle() },
  });
  state.note = `已写入 ${result.written}`;
}

function adopt(result: BundleResponse, note: string): void {
  state.bundle = result.bundle;
  state.losses = result.losses;
  state.written = result.written ?? [];
  state.dryRun = result.dryRun === true;
  state.repair = null;
  summaryDraft = null;
  paintSummary();
  state.note = note;
}

function activeBundle(): AgentWorkBundle {
  return state.repair?.bundle ?? state.bundle!;
}

async function run(task: () => Promise<void>): Promise<void> {
  setError("");
  state.busy = true;
  syncControls();
  try {
    await task();
  } catch (err) {
    setError(messageOf(err));
  } finally {
    state.busy = false;
    render();
  }
}

function render(): void {
  el<HTMLElement>("note").textContent = state.note;
  renderStats();
  renderLosses();
  renderWritten();
  renderSecret();
  renderRepair();
  syncControls();
}

function renderStats(): void {
  const stats = el<HTMLElement>("stats");
  stats.replaceChildren();
  const bundle = state.bundle;
  const items: [string, string][] = bundle
    ? [
        [String(bundle.repo_context.rules.length), "rules"],
        [String(bundle.repo_context.skills.length), "skills"],
        [String(bundle.repo_context.mcp_servers.length), "MCP"],
        [String(state.losses.length), "损失"],
      ]
    : [
        ["—", "rules"],
        ["—", "skills"],
        ["—", "MCP"],
        ["—", "损失"],
      ];
  for (const [value, label] of items) {
    const box = document.createElement("div");
    box.className = "stat";
    const strong = document.createElement("b");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;
    box.append(strong, span);
    stats.append(box);
  }
}

function renderLosses(): void {
  const list = el<HTMLElement>("losses");
  list.replaceChildren();
  const losses = state.repair?.bundle.manifest.loss_report ?? state.losses;
  if (losses.length === 0) {
    list.append(emptyLine("这次没有损失记录。"));
    return;
  }
  for (const entry of losses) {
    const item = document.createElement("li");
    item.className = "loss";
    const header = document.createElement("header");
    const code = document.createElement("code");
    code.textContent = entry.code;
    const sev = document.createElement("span");
    sev.className = `sev sev-${entry.severity}`;
    sev.textContent = entry.severity;
    header.append(code, sev);
    const message = document.createElement("p");
    message.textContent = entry.path ? `${entry.message}（${entry.path}）` : entry.message;
    item.append(header, message);
    list.append(item);
  }
}

function renderWritten(): void {
  const list = el<HTMLElement>("written");
  list.replaceChildren();
  if (state.written.length === 0) {
    list.append(emptyLine(state.dryRun ? "预演没有写文件。" : "还没有写出路径。"));
    return;
  }
  for (const path of state.written) {
    const item = document.createElement("li");
    item.className = "mono";
    item.textContent = path;
    list.append(item);
  }
}

function renderSecret(): void {
  const banner = el<HTMLElement>("secret");
  const risky = state.bundle?.repo_context.mcp_servers.some((server) => {
    const env = server.config.env;
    return !!env && Object.keys(env).length > 0;
  });
  banner.hidden = !risky;
  banner.textContent = risky ? "这份 bundle 含有 MCP env，当前版本不会自动脱敏。请不要把它提交到公开仓库。" : "";
}

function renderRepair(): void {
  const repair = state.repair;
  const progress = el<HTMLElement>("repair-progress");
  const log = el<HTMLElement>("repair-log");
  const card = el<HTMLElement>("repair-card");
  const pending = el<HTMLElement>("pending-count");
  log.replaceChildren();
  card.replaceChildren();
  if (!repair) {
    progress.textContent = "导出或上传之后，可以开始逐条修复。确认之前不会写入 Work State。";
    pending.textContent = "0";
    el<HTMLElement>("batch-body").replaceChildren();
    el<HTMLElement>("work-state").textContent = state.bundle ? renderWorkStateMarkdown(state.bundle) : "（还没有 bundle）";
    return;
  }
  const asked = Math.min(repair.cursor + 1, repair.total);
  progress.textContent =
    repair.phase === "done"
      ? `已处理 ${repair.total} 条。确认 ${repair.confirmedCount}，拒绝 ${repair.rejectedCount}。`
      : `第 ${asked} / ${repair.total} 条 · 待确认 ${repair.pendingCount} · 已确认 ${repair.confirmedCount}`;
  pending.textContent = String(repair.pendingCount);
  for (const message of repair.messages) {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${message.role}`;
    bubble.textContent = message.text;
    log.append(bubble);
  }
  log.scrollTop = log.scrollHeight;
  const current = repair.proposals.find((proposal) => proposal.id === repair.currentProposalId);
  if (current && current.status === "pending") card.append(proposalCard(current));
  renderBatch(repair);
  el<HTMLElement>("work-state").textContent = renderWorkStateMarkdown(repair.bundle);
}

function proposalCard(proposal: RepairSessionView["proposals"][number]): HTMLElement {
  const wrap = document.createElement("article");
  wrap.className = "card-draft";
  const stamp = document.createElement("div");
  stamp.className = "stamp";
  stamp.textContent = "草案 · 尚未写入";
  const title = document.createElement("h3");
  title.textContent = proposal.code;
  const preview = document.createElement("pre");
  preview.className = "preview";
  preview.textContent = proposal.preview;
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    actionButton("确认写入", () => act(`/confirm`, { ids: [proposal.id] })),
    actionButton("拒绝", () => act(`/reject`, { ids: [proposal.id] }), "danger"),
    actionButton("修改回答", () => act(`/revise`, { id: proposal.id }), "secondary"),
  );
  wrap.append(stamp, title, preview, actions);
  return wrap;
}

function renderBatch(repair: RepairSessionView): void {
  const body = el<HTMLElement>("batch-body");
  const batch = el<HTMLDetailsElement>("batch");
  const open = batch.open;
  body.replaceChildren();
  const fields: HTMLTextAreaElement[] = [];
  for (const [index, entry] of repair.losses.entries()) {
    const settled = repair.proposals.find(
      (proposal) =>
        proposal.lossIndex === index &&
        (proposal.status === "confirmed" || proposal.status === "rejected"),
    );
    const pending = repair.proposals.find(
      (proposal) => proposal.lossIndex === index && proposal.status === "pending",
    );
    const box = document.createElement("div");
    box.className = "batch-item";
    const head = document.createElement("div");
    head.className = "row-head";
    const code = document.createElement("code");
    code.textContent = `${index + 1}. ${entry.code}`;
    const status = document.createElement("span");
    if (settled?.status === "confirmed") {
      status.className = "status-ok";
      status.textContent = settled.noop ? "已确认跳过" : "已写入";
    } else if (settled?.status === "rejected") {
      status.className = "status-no";
      status.textContent = "已拒绝";
    } else if (pending) {
      status.className = "status-wait";
      status.textContent = "待确认";
    } else {
      status.className = "meta";
      status.textContent = "未起草";
    }
    head.append(code, status);
    box.append(head);
    if (pending) {
      const preview = document.createElement("pre");
      preview.className = "preview";
      preview.textContent = pending.preview;
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(
        actionButton("确认这条", () => act(`/confirm`, { ids: [pending.id] })),
        actionButton("拒绝这条", () => act(`/reject`, { ids: [pending.id] }), "danger"),
      );
      box.append(preview, actions);
    } else if (!settled) {
      const area = document.createElement("textarea");
      area.placeholder = "为这一条写回答，或填写「跳过」。生成草案不会写入。";
      fields.push(area);
      area.dataset.index = String(index);
      box.append(area);
    }
    body.append(box);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const draft = document.createElement("button");
  draft.type = "button";
  draft.className = "secondary";
  draft.textContent = "为已填写项生成草案";
  draft.addEventListener("click", () => void run(() => doDraft(fields)));
  actions.append(
    draft,
    actionButton("确认全部待定", () => act(`/confirm`, { all: true })),
    actionButton("拒绝全部待定", () => act(`/reject`, { all: true }), "danger"),
  );
  body.append(actions);
  batch.open = open;
}

function actionButton(label: string, onClick: () => Promise<void>, kind = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  if (kind) button.className = kind;
  button.textContent = label;
  button.addEventListener("click", () => void run(onClick));
  return button;
}

async function doDraft(fields: HTMLTextAreaElement[]): Promise<void> {
  if (!state.repair) return;
  const answers = fields
    .map((field) => ({ lossIndex: Number(field.dataset.index), text: field.value.trim() }))
    .filter((answer) => answer.text.length > 0);
  if (answers.length === 0) throw new Error("请至少填写一条批量回答。");
  state.repair = await api<RepairSessionView>(`/api/repair/${state.repair.id}/draft`, {
    method: "POST",
    body: { answers },
  });
  state.bundle = state.repair.bundle;
}

async function act(path: string, body: unknown): Promise<void> {
  if (!state.repair) throw new Error("请先开始修复。");
  state.repair = await api<RepairSessionView>(`/api/repair/${state.repair.id}${path}`, {
    method: "POST",
    body,
  });
  state.bundle = state.repair.bundle;
}

function downloadActive(): void {
  const bundle = state.repair?.bundle ?? state.bundle;
  if (!bundle) return;
  const blob = new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "agent-work.bundle.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

function syncControls(): void {
  const busy = state.busy;
  const hasBundle = Boolean(state.bundle);
  const project = el<HTMLInputElement>("project").value.trim();
  const work = state.repair?.bundle ?? state.bundle;
  setDisabled("browse", busy);
  setDisabled("pick-dir", busy);
  setDisabled("pick-bundle", busy);
  setDisabled("pick-notes", busy);
  setDisabled("summarize", busy || !project);
  setDisabled("export", busy);
  setDisabled("convert", busy);
  setDisabled("import", busy || !hasBundle);
  setDisabled("download", busy || !hasBundle);
  setDisabled("start-repair", busy || !hasBundle);
  setDisabled("write-sidecar", busy || !work || !project || !hasWorkStateContent(work));
  for (const button of document.querySelectorAll("#summary-editor button")) {
    if (button instanceof HTMLButtonElement) button.disabled = busy;
  }
  const phase = state.repair?.phase;
  setDisabled("repair-input", busy || !state.repair || phase === "done");
  setDisabled("repair-send", busy || !state.repair || phase === "done");
  for (const button of document.querySelectorAll("#batch-body button, #repair-card button")) {
    if (button instanceof HTMLButtonElement) button.disabled = busy;
  }
}

function setDisabled(id: string, disabled: boolean): void {
  const node = document.getElementById(id);
  if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.disabled = disabled;
  }
}

function requireProject(): string {
  const project = value("project");
  if (!project) throw new Error("请填写项目路径。");
  return project;
}

function value(id: string): string {
  const node = el<HTMLInputElement | HTMLSelectElement>(id);
  return node.value.trim();
}

function checked(id: string): boolean {
  return el<HTMLInputElement>(id).checked;
}

function emptyLine(text: string): HTMLElement {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  return item;
}

function setError(text: string): void {
  state.error = text;
  const banner = el<HTMLElement>("error");
  banner.hidden = !text;
  banner.textContent = text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
