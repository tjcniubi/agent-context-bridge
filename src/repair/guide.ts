/**
 * Guided repair over loss_report.
 *
 * Drafts a Work State patch from the user's answer and keeps it pending.
 * work_state and repair.* loss entries change only after confirm or reject.
 */
import type {
  AgentWorkBundle,
  LossReportEntry,
  WorkState,
  WorkStateDecision,
  WorkStateFileAnchor,
  WorkStateOpenLoop,
} from "../protocol/types.js";
import { draftRepairPatch, modelFailedEntry, type ModelToggle } from "../summarize/model.js";
import { loss } from "../utils/loss-report.js";

export class RepairFlowError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RepairFlowError";
    this.status = status;
  }
}

export interface WorkStatePatch {
  goal?: string;
  decisions?: WorkStateDecision[];
  open_loops?: WorkStateOpenLoop[];
  file_anchors?: WorkStateFileAnchor[];
  constraints?: string[];
  known_pitfalls?: string[];
  last_summary?: string;
}

export interface RepairMessage {
  id: string;
  role: "agent" | "user";
  text: string;
}

export interface RepairProposal {
  id: string;
  lossIndex: number;
  code: string;
  severity: LossReportEntry["severity"];
  lossMessage: string;
  path?: string;
  patch: WorkStatePatch;
  noop: boolean;
  status: "pending" | "confirmed" | "rejected";
  /** Model ledger for this draft. Copied onto the bundle only when the draft is settled. */
  draftLosses: LossReportEntry[];
}

export type RepairPhase = "asking" | "awaiting_confirm" | "done";

export interface RepairSession {
  id: string;
  phase: RepairPhase;
  losses: LossReportEntry[];
  cursor: number;
  messages: RepairMessage[];
  proposals: RepairProposal[];
  /** Confirmed fills only. Pending drafts are not copied here. */
  bundle: AgentWorkBundle;
}

export interface RepairProposalView extends RepairProposal {
  preview: string;
}

export interface RepairSessionView {
  id: string;
  phase: RepairPhase;
  cursor: number;
  total: number;
  losses: LossReportEntry[];
  messages: RepairMessage[];
  proposals: RepairProposalView[];
  bundle: AgentWorkBundle;
  pendingCount: number;
  confirmedCount: number;
  rejectedCount: number;
  currentProposalId: string | null;
}

const SKIP_RE =
  /^(跳过|skip|不用|无|没有|不需要|忽略|不记|不要|不写|pass)[.。!！\s]*$/i;
const YES_RE =
  /^(好|好的|是|是的|要|记下|记下来|记一条|yes|y|ok|okay)[.。!！\s]*$/i;

const PREFIX_RE =
  /^(目标|goal|决定|decision|待办|todo|open|文件|file|约束|constraint|坑|pitfall|摘要|summary)\s*[:：]\s*(.+)$/i;

let seq = 0;
function nid(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}`;
}

export function lossesForRepair(bundle: AgentWorkBundle): LossReportEntry[] {
  return bundle.manifest.loss_report.filter((entry) => !entry.code.startsWith("repair."));
}

export function previewPatch(patch: WorkStatePatch): string {
  const lines: string[] = [];
  if (patch.goal) lines.push(`目标：${patch.goal}`);
  if (patch.last_summary) lines.push(`摘要：${patch.last_summary}`);
  for (const d of patch.decisions ?? []) {
    lines.push(`决定：${d.summary}${d.rationale ? ` — ${d.rationale}` : ""}`);
  }
  for (const o of patch.open_loops ?? []) {
    lines.push(`待办：${o.summary}${o.priority ? ` | ${o.priority}` : ""}`);
  }
  for (const f of patch.file_anchors ?? []) {
    lines.push(`文件：${f.path}${f.note ? ` — ${f.note}` : ""}`);
  }
  for (const c of patch.constraints ?? []) lines.push(`约束：${c}`);
  for (const p of patch.known_pitfalls ?? []) lines.push(`坑：${p}`);
  return lines.join("\n");
}

export function isEmptyPatch(patch: WorkStatePatch): boolean {
  return previewPatch(patch).length === 0;
}

function cloneSession(session: RepairSession): RepairSession {
  return structuredClone(session);
}

function guideHint(code: string): string {
  if (code === "work_state.not_inferred" || code === "work_state.manual") {
    return "导出时没有自动摘要。可以先用「生成摘要预览」，或写下当前目标、已经拍板的决定，以及还没做完的事。";
  }
  if (code.startsWith("transcript.")) {
    return "对话没有进入目标端的聊天界面。请把必须记住的结论写成摘要；工具结果里的关键事实也写在这里。";
  }
  if (code.includes("other_layout") || code.includes("agents_dir_mapped")) {
    return "这些文件已经收进 bundle，只是目录布局和来源端不一样。不需要补记就回复「跳过」。";
  }
  if (code.includes("mcp.env") || code.includes("mcp.headers")) {
    return "MCP 的 env 或 headers 被保留或脱敏了。需要记住的约束写下来；否则回复「跳过」。";
  }
  if (code.includes("user_scope")) {
    return "用户级配置这次没有读全。哪些规则或服务需要稍后手工补上？";
  }
  if (code.includes("nested")) {
    return "子目录里的规则没有扫描。请给出要补看的路径，或说明缺了什么。";
  }
  if (code.includes("toggle") || code.includes("stub")) {
    return "这条提醒的是导入之后还要手工打开的开关，或尚未实现的读取。需要的话我会记成一条待办。";
  }
  if (
    code.includes("ext_normalized") ||
    code.includes("frontmatter") ||
    code.includes("md_ignored")
  ) {
    return "文件形式有改写。如果这会让人踩坑，用一句话写下；不需要就回复「跳过」。";
  }
  if (code.includes("sidecar")) {
    return "Work State 会写在 sidecar 文件里。如果还要补充目标或摘要，现在写下来。";
  }
  return "请描述应当补进 Work State 的事实。";
}

function questionFor(entry: LossReportEntry, index: number, total: number): string {
  const where = entry.path ? `\n路径：${entry.path}` : "";
  return [
    `（${index + 1}/${total}）${entry.severity} ${entry.code}${where}`,
    entry.message,
    "",
    guideHint(entry.code),
    "可以直接写一段话，或用前缀分行：目标： / 决定： / 待办： / 文件： / 约束： / 坑： / 摘要：",
    "回复「跳过」表示这条不写入 Work State，之后仍要再确认一次。",
  ].join("\n");
}

function pushAgent(session: RepairSession, text: string): void {
  session.messages.push({ id: nid("msg"), role: "agent", text });
}

function pushUser(session: RepairSession, text: string): void {
  session.messages.push({ id: nid("msg"), role: "user", text });
}

export function startRepair(bundle: AgentWorkBundle, id?: string): RepairSession {
  const stored = structuredClone(bundle);
  const losses = lossesForRepair(stored);
  const session: RepairSession = {
    id: id ?? nid("repair"),
    phase: losses.length === 0 ? "done" : "asking",
    losses,
    cursor: losses.length === 0 ? 0 : 0,
    messages: [],
    proposals: [],
    bundle: stored,
  };
  if (losses.length === 0) {
    pushAgent(session, "这份 bundle 没有需要逐条询问的损失。Work State 保持原样。");
    return session;
  }
  pushAgent(
    session,
    [
      "我是本地修复向导。我会按 loss_report 逐条问你，先起草 Work State。",
      "草案在你明确确认之前不会写入。",
      "",
      questionFor(losses[0], 0, losses.length),
    ].join("\n"),
  );
  return session;
}

type DraftResult =
  | { kind: "noop"; draftLosses?: LossReportEntry[] }
  | { kind: "patch"; patch: WorkStatePatch; draftLosses?: LossReportEntry[] }
  | { kind: "clarify"; message: string };

function normPriority(raw: string): WorkStateOpenLoop["priority"] | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "high" || v === "高") return "high";
  if (v === "medium" || v === "中") return "medium";
  if (v === "low" || v === "低") return "low";
  return undefined;
}

function parseOpenLoop(raw: string): WorkStateOpenLoop {
  const pri = raw.match(/[|｜]\s*(low|medium|high|低|中|高)\s*$/i);
  if (!pri || pri.index === undefined) {
    return { summary: raw.trim(), status: "open" };
  }
  const priority = normPriority(pri[1]);
  return {
    summary: raw.slice(0, pri.index).trim(),
    ...(priority ? { priority } : {}),
    status: "open",
  };
}

function splitNote(raw: string): [string, string?] {
  const parts = raw.split(/\s+(?:—|–|-)\s+/);
  if (parts.length < 2) return [raw.trim()];
  return [parts[0].trim(), parts.slice(1).join(" — ").trim()];
}

function parseDecision(raw: string): WorkStateDecision {
  const [summary, rationale] = splitNote(raw);
  return rationale ? { summary, rationale } : { summary };
}

function parseFile(raw: string, entry: LossReportEntry): WorkStateFileAnchor {
  const [head, note] = splitNote(raw);
  if (note && head) {
    return { path: head, note };
  }
  const token = raw.trim();
  if (token.includes("/") || token.includes("\\") || /\.[a-z0-9]+$/i.test(token)) {
    return { path: token };
  }
  return { path: entry.path || entry.code, note: token };
}

function parsePrefixed(text: string, entry: LossReportEntry): WorkStatePatch | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const patch: WorkStatePatch = {};
  let matched = 0;
  const leftover: string[] = [];
  for (const line of lines) {
    const m = line.match(PREFIX_RE);
    if (!m) {
      leftover.push(line);
      continue;
    }
    matched += 1;
    const label = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) continue;
    if (label === "目标" || label === "goal") patch.goal = appendLine(patch.goal, value);
    else if (label === "摘要" || label === "summary") {
      patch.last_summary = appendLine(patch.last_summary, value);
    } else if (label === "决定" || label === "decision") {
      patch.decisions = [...(patch.decisions ?? []), parseDecision(value)];
    } else if (label === "待办" || label === "todo" || label === "open") {
      patch.open_loops = [...(patch.open_loops ?? []), parseOpenLoop(value)];
    } else if (label === "文件" || label === "file") {
      patch.file_anchors = [...(patch.file_anchors ?? []), parseFile(value, entry)];
    } else if (label === "约束" || label === "constraint") {
      patch.constraints = [...(patch.constraints ?? []), value];
    } else if (label === "坑" || label === "pitfall") {
      patch.known_pitfalls = [...(patch.known_pitfalls ?? []), value];
    }
  }
  if (matched === 0) return undefined;
  if (leftover.length) {
    patch.last_summary = appendLine(patch.last_summary, leftover.join("\n"));
  }
  return patch;
}

function appendLine(prev: string | undefined, next: string): string {
  return prev ? `${prev}\n${next}` : next;
}

function parseFreeformWorkState(text: string): WorkStatePatch {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bullets = lines
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
  const prose = lines.filter((line) => !/^[-*•]\s+/.test(line));
  const patch: WorkStatePatch = {};
  if (prose[0]) {
    patch.goal = prose[0].slice(0, 500);
    if (prose[0].length > 500 || prose.length > 1) patch.last_summary = prose.join("\n");
  }
  if (bullets.length) {
    patch.open_loops = bullets.map((summary) => ({ summary, status: "open" as const }));
  }
  if (patch.last_summary && patch.last_summary === patch.goal) delete patch.last_summary;
  return patch;
}

function fallbackKind(code: string): "work_state" | "summary" | "loop" | "file" | "pitfall" | "goal" {
  if (code === "work_state.not_inferred" || code === "work_state.manual" || code.includes("not_inferred")) {
    return "work_state";
  }
  if (code.startsWith("transcript.")) return "summary";
  if (code.includes("user_scope") || code.includes("toggle") || code.includes("stub") || code.includes("not_implemented")) {
    return "loop";
  }
  if (code.includes("nested")) return "file";
  if (code.includes("sidecar")) return "goal";
  return "pitfall";
}

function fallbackPatch(entry: LossReportEntry, text: string): WorkStatePatch {
  const kind = fallbackKind(entry.code);
  if (kind === "work_state") return parseFreeformWorkState(text);
  if (kind === "summary") return { last_summary: text };
  if (kind === "loop") return { open_loops: [{ summary: text, status: "open" }] };
  if (kind === "file") return { file_anchors: [parseFile(text, entry)] };
  if (kind === "goal") return { goal: text.slice(0, 500) };
  return { known_pitfalls: [text] };
}

export function draftFromAnswer(entry: LossReportEntry, answer: string): DraftResult {
  const text = answer.trim();
  if (!text) {
    return { kind: "clarify", message: "请先写一段回答，或回复「跳过」。" };
  }
  if (text.length > 20000) {
    return { kind: "clarify", message: "这段回答太长了。请压到两万字以内，或只保留要写入 Work State 的句子。" };
  }
  if (SKIP_RE.test(text)) return { kind: "noop" };
  if (YES_RE.test(text)) {
    const patch = fallbackPatch(entry, entry.message);
    if (isEmptyPatch(patch)) {
      return { kind: "clarify", message: "没能把这条损失转成草案。请用自己的话写一下，或回复「跳过」。" };
    }
    return { kind: "patch", patch };
  }
  const prefixed = parsePrefixed(text, entry);
  if (prefixed) {
    if (isEmptyPatch(prefixed)) {
      return { kind: "clarify", message: "前缀后面是空的。请写上内容，或回复「跳过」。" };
    }
    return { kind: "patch", patch: prefixed };
  }
  const patch = fallbackPatch(entry, text);
  if (isEmptyPatch(patch)) {
    return {
      kind: "clarify",
      message: "没有解析出可写入的字段。请换一种说法，或使用「目标：」「待办：」「坑：」这类前缀。",
    };
  }
  return { kind: "patch", patch };
}

function assertUnset(session: RepairSession, lossIndex: number): void {
  const settled = session.proposals.find(
    (proposal) =>
      proposal.lossIndex === lossIndex &&
      (proposal.status === "confirmed" || proposal.status === "rejected"),
  );
  if (settled) {
    throw new RepairFlowError(`第 ${lossIndex + 1} 条已经处理过，不能再起草。`);
  }
}

function upsertPending(
  session: RepairSession,
  lossIndex: number,
  draft: DraftResult,
): RepairProposal {
  const entry = session.losses[lossIndex];
  if (!entry) throw new RepairFlowError(`没有第 ${lossIndex + 1} 条损失。`);
  if (draft.kind === "clarify") {
    throw new RepairFlowError(draft.message);
  }
  session.proposals = session.proposals.filter(
    (proposal) => !(proposal.lossIndex === lossIndex && proposal.status === "pending"),
  );
  const proposal: RepairProposal = {
    id: nid("prop"),
    lossIndex,
    code: entry.code,
    severity: entry.severity,
    lossMessage: entry.message,
    ...(entry.path ? { path: entry.path } : {}),
    patch: draft.kind === "patch" ? draft.patch : {},
    noop: draft.kind === "noop",
    status: "pending",
    draftLosses: [...(draft.draftLosses ?? [])],
  };
  session.proposals.push(proposal);
  return proposal;
}

function proposalText(proposal: RepairProposal): string {
  const modelNote = modelNotice(proposal);
  if (proposal.noop) {
    const lines = [`已为 ${proposal.code} 起草「不写入」。`];
    if (modelNote) lines.push(modelNote);
    lines.push("这只是草案，Work State 还没有变化。", "确认表示接受跳过；拒绝表示不接受这条处理。");
    return lines.join("\n");
  }
  const lines = [`已为 ${proposal.code} 起草，尚未写入 Work State。`];
  if (modelNote) lines.push(modelNote);
  lines.push("", previewPatch(proposal.patch), "", "请确认写入，或拒绝这条草案。");
  return lines.join("\n");
}

function modelNotice(proposal: RepairProposal): string {
  if (proposal.draftLosses.some((entry) => entry.code === "work_state.model_drafted")) {
    return "外部模型起草了这条草案。确认或拒绝之前不会写入。";
  }
  if (proposal.draftLosses.some((entry) => entry.code === "work_state.model_failed")) {
    return "外部模型没有成功，已改用规则抽取。确认或拒绝之前不会写入。";
  }
  return "";
}

function patchFromWorkState(ws: WorkState): WorkStatePatch {
  const patch: WorkStatePatch = {};
  if (ws.goal) patch.goal = ws.goal;
  if (ws.last_summary) patch.last_summary = ws.last_summary;
  if (ws.decisions.length) patch.decisions = ws.decisions.map((item) => ({ ...item }));
  if (ws.open_loops.length) patch.open_loops = ws.open_loops.map((item) => ({ ...item }));
  if (ws.file_anchors.length) patch.file_anchors = ws.file_anchors.map((item) => ({ ...item }));
  if (ws.constraints.length) patch.constraints = ws.constraints.slice();
  if (ws.known_pitfalls.length) patch.known_pitfalls = ws.known_pitfalls.slice();
  return patch;
}

async function selectDraft(entry: LossReportEntry, text: string, model?: ModelToggle): Promise<DraftResult> {
  const rule = draftFromAnswer(entry, text);
  if (!model?.enabled || rule.kind !== "patch") return rule;
  const outcome = await draftRepairPatch(model, {
    code: entry.code,
    message: entry.message,
    ...(entry.path ? { path: entry.path } : {}),
    answer: text,
  });
  if (!outcome.ok) return { ...rule, draftLosses: outcome.losses };
  const patch = patchFromWorkState(outcome.workState);
  if (isEmptyPatch(patch)) {
    return { ...rule, draftLosses: [modelFailedEntry("model returned an empty Work State")] };
  }
  return { kind: "patch", patch, draftLosses: outcome.losses };
}

export async function answerWithModel(
  session: RepairSession,
  text: string,
  model?: ModelToggle,
): Promise<RepairSession> {
  const entry = session.losses[session.cursor];
  if (!model?.enabled || session.phase !== "asking" || normalizeCommand(text) || !entry) {
    return answerCurrent(session, text);
  }
  const drafted = await selectDraft(entry, text, model);
  return answerCurrent(session, text, drafted);
}

export async function draftAnswersWithModel(
  session: RepairSession,
  answers: DraftAnswerInput[],
  model?: ModelToggle,
): Promise<RepairSession> {
  if (!model?.enabled) return draftAnswers(session, answers);
  const presets = new Map<number, DraftResult>();
  for (const answer of answers) {
    const entry = session.losses[answer.lossIndex];
    if (!entry) continue;
    presets.set(answer.lossIndex, await selectDraft(entry, answer.text, model));
  }
  return draftAnswers(session, answers, presets);
}

export function answerCurrent(session: RepairSession, text: string, preset?: DraftResult): RepairSession {
  const command = normalizeCommand(text);
  if (session.phase === "done") {
    throw new RepairFlowError("修复已经结束。可以下载 bundle。");
  }
  if (command === "confirm_all" || command === "reject_all") {
    const next = cloneSession(session);
    pushUser(next, text.trim());
    return applyChatCommand(next, command);
  }
  if (session.phase === "awaiting_confirm") {
    const next = cloneSession(session);
    pushUser(next, text.trim());
    if (command === "confirm" || command === "reject" || command === "revise") {
      return applyChatCommand(next, command);
    }
    pushAgent(
      next,
      "当前草案还没有写入。请确认、拒绝，或选择修改回答。其他内容不会被当成确认。",
    );
    return next;
  }

  const next = cloneSession(session);
  const answer = text.trim();
  pushUser(next, answer);
  if (!session.losses[session.cursor]) {
    throw new RepairFlowError("没有待回答的损失项。");
  }
  const drafted = preset ?? draftFromAnswer(session.losses[session.cursor], answer);
  if (drafted.kind === "clarify") {
    pushAgent(next, drafted.message);
    return next;
  }
  assertUnset(next, session.cursor);
  const proposal = upsertPending(next, session.cursor, drafted);
  next.phase = "awaiting_confirm";
  pushAgent(next, proposalText(proposal));
  return next;
}

export interface DraftAnswerInput {
  lossIndex: number;
  text: string;
}

export function draftAnswers(
  session: RepairSession,
  answers: DraftAnswerInput[],
  presets?: Map<number, DraftResult>,
): RepairSession {
  if (answers.length === 0) throw new RepairFlowError("请至少填写一条回答。");
  const next = cloneSession(session);
  const notes: string[] = [];
  for (const answer of answers) {
    if (!Number.isInteger(answer.lossIndex) || answer.lossIndex < 0 || answer.lossIndex >= next.losses.length) {
      throw new RepairFlowError(`损失序号无效：${String(answer.lossIndex)}`);
    }
    assertUnset(next, answer.lossIndex);
    const drafted = presets?.get(answer.lossIndex) ?? draftFromAnswer(next.losses[answer.lossIndex], answer.text);
    if (drafted.kind === "clarify") {
      throw new RepairFlowError(`第 ${answer.lossIndex + 1} 条：${drafted.message}`);
    }
    const proposal = upsertPending(next, answer.lossIndex, drafted);
    notes.push(`${proposal.code}：${proposal.noop ? "不写入" : previewPatch(proposal.patch).split("\n")[0]}`);
  }
  if (next.phase !== "done") {
    const pendingHere = next.proposals.find(
      (proposal) => proposal.lossIndex === next.cursor && proposal.status === "pending",
    );
    if (pendingHere) next.phase = "awaiting_confirm";
  }
  pushAgent(
    next,
    ["已生成草案，尚未写入 Work State。", ...notes.map((line) => `- ${line}`)].join("\n"),
  );
  return next;
}

function appendDraftLosses(session: RepairSession, proposal: RepairProposal): void {
  if (proposal.draftLosses.length === 0) return;
  session.bundle.manifest.loss_report = [
    ...session.bundle.manifest.loss_report,
    ...proposal.draftLosses.map((entry) => ({ ...entry })),
  ];
}

function applyPatch(work: WorkState, patch: WorkStatePatch): WorkState {
  return {
    ...work,
    goal: patch.goal ? appendLine(work.goal, patch.goal) : work.goal,
    last_summary: patch.last_summary
      ? appendLine(work.last_summary, patch.last_summary)
      : work.last_summary,
    decisions: [...work.decisions, ...(patch.decisions ?? [])],
    open_loops: [...work.open_loops, ...(patch.open_loops ?? [])],
    file_anchors: [...work.file_anchors, ...(patch.file_anchors ?? [])],
    constraints: [...work.constraints, ...(patch.constraints ?? [])],
    known_pitfalls: [...work.known_pitfalls, ...(patch.known_pitfalls ?? [])],
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 240);
}

function settle(session: RepairSession, proposal: RepairProposal, status: "confirmed" | "rejected"): void {
  if (proposal.status !== "pending") {
    throw new RepairFlowError(
      status === "confirmed"
        ? "这条草案已经处理过，不能再次确认。"
        : "这条草案已经处理过，不能再次拒绝。",
      409,
    );
  }
  proposal.status = status;
  appendDraftLosses(session, proposal);
  const entry = session.losses[proposal.lossIndex];
  if (status === "rejected" || proposal.noop) {
    session.bundle.manifest.loss_report = [
      ...session.bundle.manifest.loss_report,
      loss(
        proposal.noop && status === "confirmed" ? "repair.skipped" : "repair.declined",
        proposal.noop && status === "confirmed"
          ? `User confirmed skip; no work_state fill for ${proposal.code}.`
          : `User rejected proposed work_state fill for ${proposal.code}.`,
        "info",
        entry?.path,
      ),
    ];
    return;
  }
  session.bundle.work_state = applyPatch(session.bundle.work_state, proposal.patch);
  session.bundle.manifest.loss_report = [
    ...session.bundle.manifest.loss_report,
    loss(
      "repair.applied",
      `Confirmed work_state fill for ${proposal.code}: ${oneLine(previewPatch(proposal.patch))}`,
      "info",
      entry?.path,
    ),
  ];
}

function idsOrThrow(session: RepairSession, ids: string[]): RepairProposal[] {
  if (ids.length === 0) throw new RepairFlowError("没有选中草案。");
  const found: RepairProposal[] = [];
  for (const id of ids) {
    const proposal = session.proposals.find((item) => item.id === id);
    if (!proposal) throw new RepairFlowError(`找不到草案 ${id}。`);
    found.push(proposal);
  }
  return found;
}

function maybeAdvance(session: RepairSession): void {
  if (session.phase === "done") return;
  if (!isSettled(session, session.cursor)) {
    const pending = session.proposals.find(
      (proposal) => proposal.lossIndex === session.cursor && proposal.status === "pending",
    );
    if (pending) session.phase = "awaiting_confirm";
    return;
  }
  advance(session);
}

function advance(session: RepairSession): void {
  const nextIndex = session.losses.findIndex((_, index) => !isSettled(session, index));
  if (nextIndex === -1) {
    session.phase = "done";
    session.cursor = session.losses.length;
    pushAgent(
      session,
      "损失项已经全部处理。确认过的内容在 Work State 里；拒绝或跳过的没有写入。可以下载 bundle。",
    );
    return;
  }
  session.cursor = nextIndex;
  const pending = session.proposals.find(
    (proposal) => proposal.lossIndex === nextIndex && proposal.status === "pending",
  );
  if (pending) {
    session.phase = "awaiting_confirm";
    pushAgent(session, `下一条已有草案，仍未写入。\n\n${proposalText(pending)}`);
    return;
  }
  session.phase = "asking";
  pushAgent(session, questionFor(session.losses[nextIndex], nextIndex, session.losses.length));
}

function isSettled(session: RepairSession, lossIndex: number): boolean {
  return session.proposals.some(
    (proposal) =>
      proposal.lossIndex === lossIndex &&
      (proposal.status === "confirmed" || proposal.status === "rejected"),
  );
}

export function confirmProposals(session: RepairSession, ids: string[]): RepairSession {
  const next = cloneSession(session);
  const proposals = idsOrThrow(next, ids);
  for (const proposal of proposals) settle(next, proposal, "confirmed");
  const labels = proposals.map((proposal) =>
    proposal.noop ? `${proposal.code} 已确认跳过` : `${proposal.code} 已写入`,
  );
  pushAgent(next, labels.join("\n"));
  maybeAdvance(next);
  return next;
}

export function rejectProposals(session: RepairSession, ids: string[]): RepairSession {
  const next = cloneSession(session);
  const proposals = idsOrThrow(next, ids);
  for (const proposal of proposals) settle(next, proposal, "rejected");
  pushAgent(next, proposals.map((proposal) => `${proposal.code} 已拒绝，未写入。`).join("\n"));
  maybeAdvance(next);
  return next;
}

export function reviseProposal(session: RepairSession, id: string): RepairSession {
  const current = session.proposals.find((proposal) => proposal.id === id);
  if (!current || current.status !== "pending") {
    throw new RepairFlowError("只能修改尚未确认的草案。");
  }
  const next = cloneSession(session);
  next.proposals = next.proposals.filter((proposal) => proposal.id !== id);
  next.cursor = current.lossIndex;
  next.phase = "asking";
  pushAgent(next, "已撤回这条草案，Work State 没有变化。请重新回答这一条。");
  pushAgent(next, questionFor(next.losses[current.lossIndex], current.lossIndex, next.losses.length));
  return next;
}

function normalizeCommand(text: string): "confirm" | "reject" | "confirm_all" | "reject_all" | "revise" | null {
  const value = text.trim().toLowerCase();
  if (/^(全部确认|确认全部|confirm all)$/i.test(value)) return "confirm_all";
  if (/^(全部拒绝|拒绝全部|reject all)$/i.test(value)) return "reject_all";
  if (/^(确认|确认写入|写入|confirm|apply)$/i.test(value)) return "confirm";
  if (/^(拒绝|reject|否)$/i.test(value)) return "reject";
  if (/^(修改|修改回答|revise|重答)$/i.test(value)) return "revise";
  return null;
}

function applyChatCommand(
  session: RepairSession,
  command: NonNullable<ReturnType<typeof normalizeCommand>>,
): RepairSession {
  const pending = session.proposals.filter((proposal) => proposal.status === "pending");
  const current = pending.find((proposal) => proposal.lossIndex === session.cursor) ?? pending[0];
  if (command === "confirm_all" || command === "reject_all") {
    if (pending.length === 0) throw new RepairFlowError("没有待确认的草案。");
    const ids = pending.map((proposal) => proposal.id);
    return command === "confirm_all" ? confirmOnCopy(session, ids) : rejectOnCopy(session, ids);
  }
  if (!current) throw new RepairFlowError("没有待确认的草案。");
  if (command === "revise") return reviseOnCopy(session, current.id);
  if (command === "confirm") return confirmOnCopy(session, [current.id]);
  return rejectOnCopy(session, [current.id]);
}

function confirmOnCopy(session: RepairSession, ids: string[]): RepairSession {
  // answerCurrent already cloned and pushed the user message.
  const proposals = idsOrThrow(session, ids);
  for (const proposal of proposals) settle(session, proposal, "confirmed");
  pushAgent(
    session,
    proposals
      .map((proposal) => (proposal.noop ? `${proposal.code} 已确认跳过` : `${proposal.code} 已写入`))
      .join("\n"),
  );
  maybeAdvance(session);
  return session;
}

function rejectOnCopy(session: RepairSession, ids: string[]): RepairSession {
  const proposals = idsOrThrow(session, ids);
  for (const proposal of proposals) settle(session, proposal, "rejected");
  pushAgent(session, proposals.map((proposal) => `${proposal.code} 已拒绝，未写入。`).join("\n"));
  maybeAdvance(session);
  return session;
}

function reviseOnCopy(session: RepairSession, id: string): RepairSession {
  const current = session.proposals.find((proposal) => proposal.id === id);
  if (!current || current.status !== "pending") {
    throw new RepairFlowError("只能修改尚未确认的草案。");
  }
  session.proposals = session.proposals.filter((proposal) => proposal.id !== id);
  session.cursor = current.lossIndex;
  session.phase = "asking";
  pushAgent(session, "已撤回这条草案，Work State 没有变化。请重新回答这一条。");
  pushAgent(session, questionFor(session.losses[current.lossIndex], current.lossIndex, session.losses.length));
  return session;
}

export function pendingIds(session: RepairSession): string[] {
  return session.proposals.filter((proposal) => proposal.status === "pending").map((proposal) => proposal.id);
}

export function toRepairView(session: RepairSession): RepairSessionView {
  const pending = session.proposals.filter((proposal) => proposal.status === "pending");
  const current =
    pending.find((proposal) => proposal.lossIndex === session.cursor) ?? null;
  return {
    id: session.id,
    phase: session.phase,
    cursor: session.cursor,
    total: session.losses.length,
    losses: session.losses,
    messages: session.messages,
    proposals: session.proposals.map((proposal) => ({
      ...proposal,
      preview: proposal.noop ? "（不写入 Work State）" : previewPatch(proposal.patch),
    })),
    bundle: session.bundle,
    pendingCount: pending.length,
    confirmedCount: session.proposals.filter((proposal) => proposal.status === "confirmed").length,
    rejectedCount: session.proposals.filter((proposal) => proposal.status === "rejected").length,
    currentProposalId: current?.id ?? null,
  };
}
