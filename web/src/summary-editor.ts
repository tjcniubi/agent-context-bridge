import type { LossReportEntry, WorkState, WorkStateOpenLoop } from "../../src/protocol/types.ts";

export interface SummaryPreview {
  workState: WorkState;
  losses: LossReportEntry[];
  sources: { kind: string; path?: string; sessionId?: string; messages: number }[];
  sourceAgent: string;
  summaryMode?: string;
  applied?: boolean;
}

export function buildSummaryEditor(
  draft: SummaryPreview,
  handlers: { onApply: (workState: WorkState) => void; onDiscard: () => void },
): HTMLElement {
  const root = document.createElement("div");
  root.className = "summary-draft";

  const stamp = document.createElement("div");
  stamp.className = "stamp";
  stamp.textContent = "预览 · 确认后才写入 bundle";
  const intro = document.createElement("p");
  intro.className = "hint";
  intro.textContent =
    "可以改这些字段。确认后更新当前 bundle 的 Work State，并结束尚未完成的修复会话。项目文件要另外写入 .acb/WORK_STATE.md。";
  root.append(stamp, intro);

  if (draft.sources.length > 0) {
    const sources = document.createElement("ul");
    sources.className = "sources";
    for (const source of draft.sources) {
      const item = document.createElement("li");
      const bits = [source.kind, source.sessionId, source.path, `${source.messages} 条消息`].filter(Boolean);
      item.textContent = bits.join(" · ");
      sources.append(item);
    }
    root.append(sources);
  }

  root.append(lossList(draft.losses));
  root.append(area("目标", "goal", draft.workState.goal ?? ""));
  root.append(area("摘要", "last_summary", draft.workState.last_summary ?? ""));
  root.append(decisionList(draft.workState.decisions));
  root.append(loopList(draft.workState.open_loops));
  root.append(anchorList(draft.workState.file_anchors));
  root.append(stringList("约束", "constraints", draft.workState.constraints));
  root.append(stringList("已知坑", "known_pitfalls", draft.workState.known_pitfalls));

  const actions = document.createElement("div");
  actions.className = "actions";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "确认写入 bundle";
  apply.addEventListener("click", () => handlers.onApply(readWorkState(root)));
  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "secondary";
  discard.textContent = "放弃预览";
  discard.addEventListener("click", () => handlers.onDiscard());
  actions.append(apply, discard);
  root.append(actions);
  return root;
}

function area(label: string, field: string, value: string): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("textarea");
  input.dataset.field = field;
  input.value = value;
  wrap.append(input);
  return wrap;
}

function decisionList(items: WorkState["decisions"]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "stack";
  const title = document.createElement("h3");
  title.textContent = "决策";
  const list = document.createElement("div");
  list.dataset.list = "decisions";
  list.className = "stack";
  for (const item of items) addDecision(list, item.summary, item.rationale ?? "");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.textContent = "添加决策";
  add.addEventListener("click", () => addDecision(list, "", ""));
  wrap.append(title, list, add);
  return wrap;
}

function addDecision(list: HTMLElement, summary: string, rationale: string): void {
  const row = document.createElement("div");
  row.className = "edit-row";
  row.append(textInput(summary, "决策"), textInput(rationale, "理由"), removeButton(row));
  list.append(row);
}

function loopList(items: WorkStateOpenLoop[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "stack";
  const title = document.createElement("h3");
  title.textContent = "开放环";
  const list = document.createElement("div");
  list.dataset.list = "open_loops";
  list.className = "stack";
  for (const item of items) addLoop(list, item);
  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.textContent = "添加开放环";
  add.addEventListener("click", () => addLoop(list, { summary: "" }));
  wrap.append(title, list, add);
  return wrap;
}

function addLoop(list: HTMLElement, item: WorkStateOpenLoop): void {
  const row = document.createElement("div");
  row.className = "edit-row";
  row.append(
    textInput(item.summary, "事项"),
    selectInput(
      [
        ["", "优先级"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
      ],
      item.priority ?? "",
      "priority",
    ),
    selectInput(
      [
        ["", "状态"],
        ["open", "open"],
        ["blocked", "blocked"],
        ["done", "done"],
      ],
      item.status ?? "",
      "status",
    ),
    removeButton(row),
  );
  list.append(row);
}

function anchorList(items: WorkState["file_anchors"]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "stack";
  const title = document.createElement("h3");
  title.textContent = "文件锚点";
  const list = document.createElement("div");
  list.dataset.list = "file_anchors";
  list.className = "stack";
  for (const item of items) addPair(list, item.path, item.note ?? "", "路径", "备注");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.textContent = "添加文件";
  add.addEventListener("click", () => addPair(list, "", "", "路径", "备注"));
  wrap.append(title, list, add);
  return wrap;
}

function stringList(title: string, name: string, items: string[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "stack";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("div");
  list.dataset.list = name;
  list.className = "stack";
  for (const item of items) addPair(list, item, "", "内容", "");
  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary";
  add.textContent = `添加${title}`;
  add.addEventListener("click", () => addPair(list, "", "", "内容", ""));
  wrap.append(heading, list, add);
  return wrap;
}

function addPair(list: HTMLElement, first: string, second: string, firstLabel: string, secondLabel: string): void {
  const row = document.createElement("div");
  row.className = "edit-row";
  row.append(textInput(first, firstLabel));
  if (secondLabel) row.append(textInput(second, secondLabel));
  row.append(removeButton(row));
  list.append(row);
}

function textInput(value: string, placeholder: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  return input;
}

function selectInput(options: [string, string][], value: string, kind: string): HTMLSelectElement {
  const select = document.createElement("select");
  select.dataset.kind = kind;
  for (const [optionValue, label] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  return select;
}

function removeButton(row: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "danger";
  button.textContent = "删除";
  button.addEventListener("click", () => row.remove());
  return button;
}

function lossList(losses: LossReportEntry[]): HTMLElement {
  const list = document.createElement("ul");
  list.className = "losses";
  if (losses.length === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "这次摘要没有损失记录。";
    list.append(item);
    return list;
  }
  for (const entry of losses) {
    const item = document.createElement("li");
    item.className = "loss";
    const header = document.createElement("header");
    const code = document.createElement("code");
    code.textContent = entry.code;
    const severity = document.createElement("span");
    severity.className = `sev sev-${entry.severity}`;
    severity.textContent = entry.severity;
    header.append(code, severity);
    const message = document.createElement("p");
    message.textContent = entry.path ? `${entry.message}（${entry.path}）` : entry.message;
    item.append(header, message);
    list.append(item);
  }
  return list;
}

function readWorkState(root: HTMLElement): WorkState {
  const goal = valueOf(root, "goal");
  const last = valueOf(root, "last_summary");
  return {
    ...(goal ? { goal } : {}),
    ...(last ? { last_summary: last } : {}),
    decisions: rows(root, "decisions")
      .map((row) => {
        const [summary, rationale] = texts(row);
        return summary ? { summary, ...(rationale ? { rationale } : {}) } : undefined;
      })
      .filter((item): item is { summary: string; rationale?: string } => Boolean(item)),
    open_loops: rows(root, "open_loops")
      .map((row) => {
        const summary = texts(row)[0] ?? "";
        if (!summary) return undefined;
        const priority = row.querySelector<HTMLSelectElement>("[data-kind=priority]")?.value;
        const status = row.querySelector<HTMLSelectElement>("[data-kind=status]")?.value;
        return {
          summary,
          ...(priority === "low" || priority === "medium" || priority === "high" ? { priority } : {}),
          ...(status === "open" || status === "blocked" || status === "done" ? { status } : {}),
        };
      })
      .filter((item): item is WorkStateOpenLoop => Boolean(item)),
    file_anchors: rows(root, "file_anchors")
      .map((row) => {
        const [path, note] = texts(row);
        return path ? { path, ...(note ? { note } : {}) } : undefined;
      })
      .filter((item): item is { path: string; note?: string } => Boolean(item)),
    constraints: rows(root, "constraints")
      .map((row) => texts(row)[0] ?? "")
      .filter(Boolean),
    known_pitfalls: rows(root, "known_pitfalls")
      .map((row) => texts(row)[0] ?? "")
      .filter(Boolean),
  };
}

function valueOf(root: HTMLElement, field: string): string {
  return root.querySelector<HTMLTextAreaElement>(`textarea[data-field="${field}"]`)?.value.trim() ?? "";
}

function rows(root: HTMLElement, list: string): HTMLElement[] {
  const host = root.querySelector<HTMLElement>(`[data-list="${list}"]`);
  if (!host) return [];
  return [...host.querySelectorAll<HTMLElement>(":scope > .edit-row")];
}

function texts(row: HTMLElement): string[] {
  return [...row.querySelectorAll("input[type=text]")].map((input) => (input as HTMLInputElement).value.trim());
}
