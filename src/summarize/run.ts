/**
 * Fill Work State from Cursor sessions, Trae plaintext exports, and notes.
 * Encrypted Trae databases are reported and never opened.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentWorkBundle, LossReportEntry, WorkState } from "../protocol/types.js";
import { emptyRepoContext, emptyWorkState } from "../protocol/types.js";
import { UserInputError } from "../core/errors.js";
import { loss } from "../utils/loss-report.js";
import { composeLastSummary, extractWorkState, type ExtractOutput, type WorkField } from "./extract.js";
import {
  draftWorkState,
  modelFailedEntry,
  type ModelToggle,
} from "./model.js";
import {
  loadCursorSessions,
  parseTranscriptDocument,
  probeTraeDatabases,
  type SessionMessage,
  type SummarySource,
} from "./sessions.js";

export { normalizeLosses, normalizeWorkState } from "./normalize.js";

const TEXT_CAP = 8000;
const NOTES_CAP = 500_000;
const DEFAULT_MAX_MESSAGES = 400;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface TranscriptText {
  name: string;
  text: string;
}

export interface SummarizeOptions {
  projectRoot: string;
  agent?: "cursor" | "trae" | "both";
  sessionId?: string;
  transcriptPaths?: string[];
  transcriptTexts?: TranscriptText[];
  notesPath?: string;
  notesText?: string;
  cursorHome?: string;
  homeDir?: string;
  maxSessions?: number;
  maxMessages?: number;
  maxFileBytes?: number;
  /** When enabled, draft Work State with an external model. Failures fall back to rules. */
  model?: ModelToggle;
}

export interface SummarizeResult {
  workState: WorkState;
  summaryMode: "structured" | "compose" | "none";
  filledFields: WorkField[];
  losses: LossReportEntry[];
  sources: SummarySource[];
  sourceAgent: string;
}

export function parseAgent(value: string): "cursor" | "trae" | "both" {
  const agent = value.trim().toLowerCase();
  if (agent === "cursor" || agent === "trae" || agent === "both") return agent;
  throw new UserInputError("agent 必须是 cursor、trae 或 both。");
}

export async function summarizeSessions(opts: SummarizeOptions): Promise<SummarizeResult> {
  const agent = opts.agent ?? "both";
  const home = opts.homeDir ? resolve(opts.homeDir) : homedir();
  const cursorHome = opts.cursorHome ? resolve(opts.cursorHome) : join(home, ".cursor");
  const losses: LossReportEntry[] = [];
  const sources: SummarySource[] = [];
  const notes: string[] = [];
  const messages: SessionMessage[] = [];
  let truncated = false;

  if (opts.notesText?.trim()) {
    const text = capNotes(opts.notesText, losses, "notes");
    notes.push(text);
    sources.push({ kind: "notes", messages: 1 });
  }
  if (opts.notesPath) {
    const loaded = await readOptionalText(opts.notesPath);
    if (loaded.missing) {
      losses.push(
        loss("summarize.notes.missing", `Notes file was not found: ${opts.notesPath}`, "error", opts.notesPath),
      );
    } else {
      notes.push(capNotes(loaded.text, losses, opts.notesPath));
      sources.push({ kind: "notes", path: opts.notesPath, messages: 1 });
    }
  }

  for (const filePath of opts.transcriptPaths ?? []) {
    const loaded = await readOptionalText(filePath);
    if (loaded.missing) {
      losses.push(
        loss(
          "summarize.transcript.missing",
          `Transcript file was not found: ${filePath}`,
          "error",
          filePath,
        ),
      );
      continue;
    }
    absorbDocument(filePath, capNotes(loaded.text, losses, filePath), messages, notes, sources, losses);
  }
  for (const doc of opts.transcriptTexts ?? []) {
    const name = doc.name?.trim() || "transcript.txt";
    absorbDocument(name, capNotes(doc.text ?? "", losses, name), messages, notes, sources, losses);
  }

  if (agent !== "trae") {
    const cursor = await loadCursorSessions({
      projectRoot: opts.projectRoot,
      cursorHome,
      sessionId: opts.sessionId,
      maxSessions: opts.maxSessions && opts.maxSessions > 0 ? opts.maxSessions : 1,
      maxFileBytes: opts.maxFileBytes && opts.maxFileBytes > 0 ? opts.maxFileBytes : DEFAULT_MAX_FILE_BYTES,
    });
    losses.push(...cursor.losses);
    sources.push(...cursor.sources);
    messages.push(...cursor.messages);
  }
  if (agent !== "cursor") {
    losses.push(...(await probeTraeDatabases(home)));
  }

  const capped = capMessages(messages, opts.maxMessages && opts.maxMessages > 0 ? opts.maxMessages : DEFAULT_MAX_MESSAGES);
  if (capped.truncated) truncated = true;
  const visible = capped.messages.map((message) => {
    if (message.content.length <= TEXT_CAP) return message;
    truncated = true;
    return { ...message, content: message.content.slice(0, TEXT_CAP) };
  });

  if (truncated) {
    losses.push(
      loss(
        "summarize.truncated",
        `Kept at most ${opts.maxMessages || DEFAULT_MAX_MESSAGES} messages and ${TEXT_CAP} characters of text per message.`,
        "info",
      ),
    );
  }

  const readable = notes.some((note) => note.trim()) || visible.length > 0;
  if (!readable) {
    losses.push(
      loss(
        "summarize.no_source",
        "No readable session text or notes were found.",
        "warn",
      ),
    );
  }

  const ruleExtract = extractWorkState({
    messages: visible.map((message) => ({ role: message.role, content: message.content })),
    notes,
  });
  const extracted = await chooseExtract(opts.model, ruleExtract, notes, visible, readable, losses);
  losses.push(
    loss(
      "summarize.transcript_not_copied",
      "Session text was not copied into bundle.transcript. Tool results, attachments, and encrypted chats stay out of the bundle.",
      "info",
    ),
  );

  const cursorMessages = sources.some((source) => source.kind === "cursor" && source.messages > 0);
  const sourceAgent = agent === "cursor" || agent === "trae" ? agent : cursorMessages ? "cursor" : "unknown";

  return {
    workState: extracted.workState,
    summaryMode: extracted.summaryMode,
    filledFields: extracted.filledFields,
    losses: dedupeLosses(losses),
    sources,
    sourceAgent,
  };
}

export function summaryLossesFor(existing: WorkState | undefined, result: SummarizeResult): LossReportEntry[] {
  const losses = result.losses.slice();
  if (!existing) return losses;
  const filled = new Set(result.filledFields);
  const kept: string[] = [];
  if (!filled.has("goal") && existing.goal) kept.push("goal");
  if (!filled.has("decisions") && existing.decisions.length) kept.push("decisions");
  if (!filled.has("open_loops") && existing.open_loops.length) kept.push("open_loops");
  if (!filled.has("file_anchors") && existing.file_anchors.length) kept.push("file_anchors");
  if (!filled.has("constraints") && existing.constraints.length) kept.push("constraints");
  if (!filled.has("known_pitfalls") && existing.known_pitfalls.length) kept.push("known_pitfalls");
  if (result.summaryMode === "none" && existing.last_summary) kept.push("last_summary");
  if (kept.length) {
    losses.push(
      loss(
        "summarize.kept_existing",
        `No new extract for: ${kept.join(", ")}. The preview kept the previous values.`,
        "info",
      ),
    );
  }
  return losses;
}

export function mergeSummary(existing: WorkState | undefined, result: SummarizeResult): WorkState {
  const base = existing ?? emptyWorkState();
  const src = result.workState;
  const filled = new Set(result.filledFields);
  const next: WorkState = {
    goal: filled.has("goal") ? src.goal : base.goal,
    decisions: filled.has("decisions") ? src.decisions.map((item) => ({ ...item })) : base.decisions.map((item) => ({ ...item })),
    open_loops: filled.has("open_loops") ? src.open_loops.map((item) => ({ ...item })) : base.open_loops.map((item) => ({ ...item })),
    file_anchors: filled.has("file_anchors")
      ? src.file_anchors.map((item) => ({ ...item }))
      : base.file_anchors.map((item) => ({ ...item })),
    constraints: filled.has("constraints") ? src.constraints.slice() : base.constraints.slice(),
    known_pitfalls: filled.has("known_pitfalls") ? src.known_pitfalls.slice() : base.known_pitfalls.slice(),
  };
  if (result.summaryMode === "structured") next.last_summary = src.last_summary;
  else if (result.summaryMode === "compose") next.last_summary = composeLastSummary(next) ?? base.last_summary;
  else next.last_summary = base.last_summary;
  return next;
}

export function applyWorkState(opts: {
  existing?: AgentWorkBundle;
  workState: WorkState;
  summaryLosses: LossReportEntry[];
  projectRoot?: string;
  sourceAgent?: string;
  confirmed?: boolean;
  written?: boolean;
  now?: string;
}): AgentWorkBundle {
  const content = workStateHasContent(opts.workState);
  const incoming = dedupeLosses(
    opts.summaryLosses.filter((entry) => entry.code !== "summarize.confirmed" && entry.code !== "summarize.written"),
  );
  if (opts.confirmed) {
    incoming.push(
      loss(
        "summarize.confirmed",
        "Work State was confirmed in the local UI before it was stored on the bundle.",
        "info",
      ),
    );
  }
  if (opts.written) {
    incoming.push(
      loss(
        "summarize.written",
        "Work State was written to the bundle by acb summarize.",
        "info",
      ),
    );
  }
  if (opts.existing) {
    const bundle = structuredClone(opts.existing);
    const kept = bundle.manifest.loss_report.filter((entry) => {
      if (entry.code.startsWith("summarize.")) return false;
      if (content && entry.code === "work_state.not_inferred") return false;
      return true;
    });
    bundle.manifest.loss_report = dedupeLosses([...kept, ...incoming]);
    bundle.work_state = opts.workState;
    if (opts.projectRoot && !bundle.manifest.project_root) bundle.manifest.project_root = opts.projectRoot;
    return bundle;
  }
  return {
    manifest: {
      version: "0.1",
      source_agent: opts.sourceAgent?.trim() || "unknown",
      created_at: opts.now ?? new Date().toISOString(),
      ...(opts.projectRoot ? { project_root: opts.projectRoot } : {}),
      loss_report: dedupeLosses(incoming),
    },
    repo_context: emptyRepoContext(),
    work_state: opts.workState,
  };
}

function workStateHasContent(ws: WorkState): boolean {
  return Boolean(
    ws.goal ||
      ws.last_summary ||
      ws.decisions.length ||
      ws.open_loops.length ||
      ws.file_anchors.length ||
      ws.constraints.length ||
      ws.known_pitfalls.length,
  );
}

function absorbDocument(
  name: string,
  text: string,
  messages: SessionMessage[],
  notes: string[],
  sources: SummarySource[],
  losses: LossReportEntry[],
): void {
  const parsed = parseTranscriptDocument(text, name);
  if (parsed.kind === "error") {
    losses.push(loss("summarize.transcript.unreadable", parsed.message, "error", name));
    return;
  }
  if (parsed.kind === "notes") {
    notes.push(text);
    sources.push({ kind: "file", path: name, messages: 0 });
    return;
  }
  if (parsed.skippedLines > 0) {
    losses.push(
      loss(
        "summarize.jsonl.skipped_lines",
        `Skipped ${parsed.skippedLines} unreadable JSONL line(s).`,
        "warn",
        name,
      ),
    );
  }
  if (parsed.dropped.length > 0) {
    losses.push(
      loss(
        "summarize.tool_results_dropped",
        `Non-text parts were not recovered: ${parsed.dropped.join(", ")}.`,
        "warn",
        name,
      ),
    );
  }
  sources.push({ kind: "file", path: name, messages: parsed.messages.length });
  messages.push(...parsed.messages);
}

function capMessages(
  messages: SessionMessage[],
  max: number,
): { messages: SessionMessage[]; truncated: boolean } {
  if (messages.length <= max) return { messages, truncated: false };
  const firstUser = messages.findIndex((message) => message.role === "user" && message.content.trim());
  const tailCount = Math.max(1, max - 1);
  const tail = messages.slice(-tailCount);
  if (firstUser >= 0 && !tail.includes(messages[firstUser]!)) {
    return { messages: [messages[firstUser]!, ...tail].slice(0, max), truncated: true };
  }
  return { messages: messages.slice(-max), truncated: true };
}

function capNotes(text: string, losses: LossReportEntry[], label: string): string {
  if (text.length <= NOTES_CAP) return text;
  losses.push(
    loss("summarize.truncated", `Trimmed ${label} to ${NOTES_CAP} characters.`, "info", label),
  );
  return text.slice(0, NOTES_CAP);
}

async function readOptionalText(file: string): Promise<{ missing: true } | { missing: false; text: string }> {
  try {
    return { missing: false, text: await readFile(file, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    throw new UserInputError(`Failed to read ${file}: ${(err as Error).message}`);
  }
}

function dedupeLosses(entries: LossReportEntry[]): LossReportEntry[] {
  const seen = new Set<string>();
  const out: LossReportEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.severity}\0${entry.code}\0${entry.message}\0${entry.path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

async function chooseExtract(
  model: ModelToggle | undefined,
  ruleExtract: ExtractOutput,
  notes: string[],
  messages: SessionMessage[],
  readable: boolean,
  losses: LossReportEntry[],
): Promise<ExtractOutput> {
  if (!model?.enabled) {
    pushRuleExtractLosses(losses, ruleExtract);
    return ruleExtract;
  }
  if (!readable) {
    losses.push(
      modelFailedEntry("no readable session text or notes, so the model was not called"),
    );
    pushRuleExtractLosses(losses, ruleExtract);
    return ruleExtract;
  }
  const drafted = await draftWorkState(model, {
    notes,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
  });
  losses.push(...drafted.losses);
  if (!drafted.ok) {
    pushRuleExtractLosses(losses, ruleExtract);
    return ruleExtract;
  }
  if (drafted.extracted.summaryMode === "compose") pushComposedLoss(losses);
  return drafted.extracted;
}

function pushRuleExtractLosses(losses: LossReportEntry[], extracted: ExtractOutput): void {
  if (extracted.structuredFields.length) {
    losses.push(
      loss(
        "summarize.notes_structured",
        `Structured note headings used for: ${extracted.structuredFields.join(", ")}.`,
        "info",
      ),
    );
  }
  if (extracted.heuristicFields.length) {
    losses.push(
      loss(
        "summarize.heuristic",
        `Rule-based extract (not a model summary) filled: ${extracted.heuristicFields.join(", ")}. Review it before handoff.`,
        "info",
      ),
    );
  }
  if (extracted.emptySections.length) {
    losses.push(
      loss(
        "summarize.section.empty",
        `Headings were present but empty for: ${extracted.emptySections.join(", ")}.`,
        "info",
      ),
    );
  }
  if (extracted.summaryMode === "compose") pushComposedLoss(losses);
  if (extracted.filledFields.length === 0 && extracted.summaryMode !== "structured") {
    losses.push(
      loss(
        "summarize.empty",
        "No goal, decisions, open loops, anchors, constraints, or pitfalls could be inferred. Notes can use headings such as 目标, 决策, and 开放环.",
        "warn",
      ),
    );
  }
}

function pushComposedLoss(losses: LossReportEntry[]): void {
  losses.push(
    loss(
      "summarize.last_summary.composed",
      "last_summary was composed from Work State fields. It is a lossy extract, not a full transcript.",
      "info",
    ),
  );
}
