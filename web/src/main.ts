import type { AgentWorkBundle, LossReportEntry } from "../../src/protocol/types.ts";
import { hasWorkStateContent, renderWorkStateMarkdown } from "../../src/protocol/work-state-markdown.ts";
import { api, type AdapterInfo, type BundleResponse, type FileChange, type RepairSessionView } from "./api.ts";

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
  changes: FileChange[];
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
  changes: [],
  dryRun: false,
  repair: null,
  dir: null,
};

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
      <p class="lede">在本机把项目或 bundle 在 Cursor 与 Trae 之间导出、导入、转换。修复向导会逐条询问损失清单，起草 Work State，并在你确认之后才写入。有损 transcript 可以预览，确认之后才写成 sidecar。</p>
    </header>
    <div id="error" class="banner error" hidden></div>
    <div class="layout">
      <section class="panel">
        <h2>来源</h2>
        <div class="stack">
          <label>项目路径
            <span class="path-row">
              <input id="project" type="text" placeholder="/path/to/project" autocomplete="off" />
              <button id="browse" class="secondary" type="button">浏览</button>
            </span>
          </label>
          <p class="hint">路径由本机服务读取。页面默认只监听回环地址。</p>
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
            <label><input id="include-user" type="checkbox" /> 包含用户级配置（用户 MCP env 会脱敏）</label>
            <label><input id="include-transcript" type="checkbox" /> 包含有损 transcript（不解密本地库）</label>
          </div>
          <label>会话 id，或项目内的明文导出路径（可选）
            <input id="session-id" type="text" placeholder="session id 或 .acb/imports/transcript.md" />
          </label>
          <div class="actions">
            <button id="export" type="button">导出</button>
            <button id="convert" type="button">转换到目标</button>
            <button id="import" class="secondary" type="button">导入到目标</button>
          </div>
          <label class="file">上传 bundle
            <input id="bundle-file" type="file" accept="application/json,.json" />
          </label>
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
        <h3>transcript</h3>
        <p id="transcript-note" class="meta"></p>
        <div id="transcript" class="transcript"></div>
        <div class="actions">
          <button id="apply-transcript" class="secondary" type="button">确认写入 .acb/TRANSCRIPT.md</button>
        </div>
        <div class="actions">
          <button id="download" class="secondary" type="button">下载 bundle</button>
          <button id="start-repair" type="button">开始逐条修复</button>
        </div>
      </section>
    </div>
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
  el<HTMLInputElement>("project").addEventListener("input", () => syncControls());
  el<HTMLButtonElement>("export").addEventListener("click", () => void run(() => doExport()));
  el<HTMLButtonElement>("convert").addEventListener("click", () => void run(() => doConvert()));
  el<HTMLButtonElement>("import").addEventListener("click", () => void run(() => doImport()));
  el<HTMLButtonElement>("download").addEventListener("click", () => downloadActive());
  el<HTMLButtonElement>("start-repair").addEventListener("click", () => void run(() => doStartRepair()));
  el<HTMLButtonElement>("write-sidecar").addEventListener("click", () => void run(() => doWriteSidecar()));
  el<HTMLButtonElement>("apply-transcript").addEventListener("click", () => void run(() => doApplyTranscript()));
  el<HTMLInputElement>("bundle-file").addEventListener("change", () => void run(() => doUpload()));
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
      includeTranscript: checked("include-transcript"),
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
      includeTranscript: checked("include-transcript"),
      sessionId: value("session-id"),
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
      includeUser: checked("include-user"),
    },
  });
  adopt(result, result.dryRun ? "导入已预演，项目文件没有改动。" : "导入完成。");
}

async function doUpload(): Promise<void> {
  const input = el<HTMLInputElement>("bundle-file");
  const file = input.files?.[0];
  if (!file) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error("上传的文件不是合法 JSON。");
  }
  const result = await api<BundleResponse & { ok: boolean }>("/api/validate", {
    method: "POST",
    body: { bundle: parsed },
  });
  adopt(result, `已载入 ${file.name}。`);
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

async function doApplyTranscript(): Promise<void> {
  const bundle = activeBundle();
  if (!bundle.transcript) throw new Error("当前 bundle 没有 transcript。");
  const project = requireProject();
  const dryRun = checked("dry-run");
  const ok = window.confirm(
    dryRun
      ? `预演写入\n${project}/.acb/TRANSCRIPT.md ？\n不会改聊天界面。`
      : `把有损 transcript 写到\n${project}/.acb/TRANSCRIPT.md ？\n不会写入聊天界面，也不会解密本地库。`,
  );
  if (!ok) return;
  const result = await api<{ written: string[]; changes: FileChange[]; preview: string }>("/api/transcript/apply", {
    method: "POST",
    body: { project, bundle, confirm: true, dryRun },
  });
  state.written = result.written;
  state.changes = result.changes;
  state.dryRun = dryRun;
  state.note = dryRun ? "transcript 预演完成，没有写文件。" : "已写入 .acb/TRANSCRIPT.md。聊天界面没有改动。";
}

function adopt(result: BundleResponse, note: string): void {
  state.bundle = result.bundle;
  state.losses = result.losses;
  state.written = result.written ?? [];
  state.changes = result.changes ?? [];
  state.dryRun = result.dryRun === true;
  state.repair = null;
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
  renderTranscript();
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
        [String(bundle.transcript?.messages.length ?? 0), "transcript"],
        [String(state.losses.length), "损失"],
      ]
    : [
        ["—", "rules"],
        ["—", "skills"],
        ["—", "MCP"],
        ["—", "transcript"],
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
  if (state.changes.length === 0 && state.written.length === 0) {
    list.append(emptyLine(state.dryRun ? "预演没有写文件。" : "还没有写出路径。"));
    return;
  }
  if (state.changes.length > 0) {
    for (const change of state.changes) {
      const item = document.createElement("li");
      item.className = "mono";
      item.textContent = `${change.action} ${change.path}`;
      list.append(item);
    }
    return;
  }
  for (const path of state.written) {
    const item = document.createElement("li");
    item.className = "mono";
    item.textContent = path;
    list.append(item);
  }
}

function renderTranscript(): void {
  const note = el<HTMLElement>("transcript-note");
  const box = el<HTMLElement>("transcript");
  box.replaceChildren();
  const transcript = (state.repair?.bundle ?? state.bundle)?.transcript;
  if (!transcript) {
    note.textContent = "没有 transcript。勾选「包含有损 transcript」后再导出，或上传一份带 transcript 的 bundle。";
    return;
  }
  note.textContent = `${transcript.messages.length} 条${transcript.source_session_id ? ` · ${transcript.source_session_id}` : ""}${transcript.notes ? ` · ${transcript.notes}` : ""}`;
  const shown = transcript.messages.slice(0, 40);
  for (const [index, message] of shown.entries()) {
    const item = document.createElement("article");
    item.className = "t-msg";
    const header = document.createElement("header");
    const role = document.createElement("strong");
    role.textContent = `${index + 1}. ${message.role}`;
    header.append(role);
    if (message.dropped_fields?.length) {
      const dropped = document.createElement("span");
      dropped.className = "meta";
      dropped.textContent = message.dropped_fields.join(", ");
      header.append(dropped);
    }
    const body = document.createElement("p");
    const text = message.content.trim() || "（空）";
    body.textContent = text.length > 600 ? `${text.slice(0, 600)}…` : text;
    item.append(header, body);
    box.append(item);
  }
  if (transcript.messages.length > shown.length) {
    const more = document.createElement("p");
    more.className = "meta";
    more.textContent = `还有 ${transcript.messages.length - shown.length} 条未展开。`;
    box.append(more);
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
  setDisabled("export", busy);
  setDisabled("convert", busy);
  setDisabled("import", busy || !hasBundle);
  setDisabled("download", busy || !hasBundle);
  setDisabled("start-repair", busy || !hasBundle);
  setDisabled("write-sidecar", busy || !work || !project || !hasWorkStateContent(work));
  setDisabled("apply-transcript", busy || !work?.transcript || !project);
  setDisabled("bundle-file", busy);
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
