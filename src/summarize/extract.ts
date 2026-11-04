/**
 * Rule-based Work State extract.
 * Structured markdown headings win. Otherwise labeled lines and file paths are collected.
 * This is not a model summary and not a full transcript.
 */
import type {
  WorkState,
  WorkStateDecision,
  WorkStateFileAnchor,
  WorkStateOpenLoop,
} from "../protocol/types.js";
import { emptyWorkState } from "../protocol/types.js";

export type WorkField =
  | "goal"
  | "decisions"
  | "open_loops"
  | "file_anchors"
  | "constraints"
  | "known_pitfalls"
  | "last_summary";

export interface ExtractInput {
  messages: { role: string; content: string }[];
  notes: string[];
}

export interface ExtractOutput {
  workState: WorkState;
  filledFields: WorkField[];
  blockedFields: WorkField[];
  summaryMode: "structured" | "compose" | "none";
  heuristicFields: WorkField[];
  structuredFields: WorkField[];
  emptySections: WorkField[];
}

const HEADINGS: Record<string, WorkField> = {
  goal: "goal",
  目标: "goal",
  decisions: "decisions",
  decision: "decisions",
  决策: "decisions",
  "open loops": "open_loops",
  "open loop": "open_loops",
  开放环: "open_loops",
  待办: "open_loops",
  "file anchors": "file_anchors",
  "file anchor": "file_anchors",
  files: "file_anchors",
  文件锚点: "file_anchors",
  锚点: "file_anchors",
  constraints: "constraints",
  constraint: "constraints",
  约束: "constraints",
  "known pitfalls": "known_pitfalls",
  pitfalls: "known_pitfalls",
  pitfall: "known_pitfalls",
  已知坑: "known_pitfalls",
  踩坑: "known_pitfalls",
  summary: "last_summary",
  "last summary": "last_summary",
  摘要: "last_summary",
};

const LINE_RULES: { field: WorkField; re: RegExp }[] = [
  { field: "decisions", re: /^(?:[-*]\s*)?(?:decisions?|决定|拍板)\s*[:：]\s*(.+)$/i },
  { field: "decisions", re: /^(?:[-*]\s*)?we decided(?:\s+to)?\s+(.+)$/i },
  { field: "open_loops", re: /^(?:[-*]\s*)?(?:TODO|FIXME|XXX)\b[:\s-]*(.+)$/i },
  { field: "open_loops", re: /^(?:[-*]\s*)?(?:open loops?|待办|未完成|下一步)\s*[:：]\s*(.+)$/i },
  { field: "open_loops", re: /^(?:[-*]\s*)?\[ \]\s+(.+)$/ },
  { field: "constraints", re: /^(?:[-*]\s*)?(?:constraints?|约束)\s*[:：]\s*(.+)$/i },
  { field: "constraints", re: /^(?:[-*]\s*)?(?:must(?:\s+not)?|do not|never)\b\s*[:：]?\s*(.+)$/i },
  { field: "constraints", re: /^(?:[-*]\s*)?(?:不要|禁止)\s*[:：]\s*(.+)$/ },
  { field: "constraints", re: /^(?:[-*]\s+)(?:不要|禁止)\s+(.+)$/ },
  { field: "known_pitfalls", re: /^(?:[-*]\s*)?(?:known pitfalls?|pitfalls?|gotchas?|已知坑|踩坑)\s*[:：]\s*(.+)$/i },
  {
    field: "file_anchors",
    re: /^(?:[-*]\s*)?(?:files?|file anchors?|文件|锚点)\s*[:：]\s*`?([^\s`]+)`?(?:\s*[:：—–-]\s*(.+))?$/i,
  },
];

const MAX_ITEMS = 20;
const MAX_GOAL = 1000;
const MAX_ITEM = 500;
const MAX_SUMMARY = 4000;
const MAX_LINE = 300;

export function extractWorkState(input: ExtractInput): ExtractOutput {
  const sections = new Map<WorkField, string>();
  const corpus: string[] = [];

  for (const note of input.notes) {
    const blocks = splitBlocks(stripFences(note));
    for (const block of blocks) {
      if (!block.heading) {
        corpus.push(block.body);
        continue;
      }
      const field = HEADINGS[block.heading];
      if (!field) {
        corpus.push(block.body);
        continue;
      }
      if (!sections.has(field)) sections.set(field, block.body);
    }
  }

  for (const message of input.messages) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
      continue;
    }
    corpus.push(stripFences(message.content));
  }

  const workState = emptyWorkState();
  const filledFields: WorkField[] = [];
  const blockedFields: WorkField[] = [];
  const heuristicFields: WorkField[] = [];
  const structuredFields: WorkField[] = [];
  const emptySections: WorkField[] = [];

  if (sections.has("goal")) {
    const goal = clip(sections.get("goal")?.trim() ?? "", MAX_GOAL);
    if (goal) {
      workState.goal = goal;
      filledFields.push("goal");
      structuredFields.push("goal");
    } else {
      blockedFields.push("goal");
      emptySections.push("goal");
    }
  } else {
    const goal = heuristicGoal(input.messages, corpus);
    if (goal) {
      workState.goal = goal;
      filledFields.push("goal");
      heuristicFields.push("goal");
    }
  }

  fillListField(sections, "decisions", workState, filledFields, blockedFields, structuredFields, emptySections, heuristicFields, () =>
    decisionsFrom(corpus),
  (items) => {
    workState.decisions = items;
  }, parseDecisions);

  fillListField(sections, "open_loops", workState, filledFields, blockedFields, structuredFields, emptySections, heuristicFields, () =>
    loopsFrom(corpus),
  (items) => {
    workState.open_loops = items;
  }, parseLoops);

  fillListField(sections, "constraints", workState, filledFields, blockedFields, structuredFields, emptySections, heuristicFields, () =>
    labeled(corpus, "constraints").map((item) => clip(item, MAX_ITEM)),
  (items) => {
    workState.constraints = dedupe(items);
  }, (body) => dedupe(listItems(body).map((item) => clip(item, MAX_ITEM))));

  fillListField(sections, "known_pitfalls", workState, filledFields, blockedFields, structuredFields, emptySections, heuristicFields, () =>
    labeled(corpus, "known_pitfalls").map((item) => clip(item, MAX_ITEM)),
  (items) => {
    workState.known_pitfalls = dedupe(items);
  }, (body) => dedupe(listItems(body).map((item) => clip(item, MAX_ITEM))));

  if (sections.has("file_anchors")) {
    const anchors = parseAnchors(listItems(sections.get("file_anchors") ?? ""));
    if (anchors.length) {
      workState.file_anchors = anchors;
      filledFields.push("file_anchors");
      structuredFields.push("file_anchors");
    } else {
      blockedFields.push("file_anchors");
      emptySections.push("file_anchors");
    }
  } else {
    const anchors = anchorsFrom(corpus);
    if (anchors.length) {
      workState.file_anchors = anchors;
      filledFields.push("file_anchors");
      heuristicFields.push("file_anchors");
    }
  }

  let summaryMode: ExtractOutput["summaryMode"] = "none";
  if (sections.has("last_summary")) {
    const summary = clip(sections.get("last_summary")?.trim() ?? "", MAX_SUMMARY);
    if (summary) {
      workState.last_summary = summary;
      structuredFields.push("last_summary");
      summaryMode = "structured";
    } else {
      blockedFields.push("last_summary");
      emptySections.push("last_summary");
    }
  } else if (filledFields.length > 0) {
    summaryMode = "compose";
  }

  return {
    workState,
    filledFields,
    blockedFields,
    summaryMode,
    heuristicFields,
    structuredFields,
    emptySections,
  };
}

export function composeLastSummary(ws: WorkState): string | undefined {
  const lines: string[] = [];
  if (ws.goal) lines.push(`Goal: ${ws.goal}`);
  if (ws.decisions.length) {
    lines.push("Decisions:");
    for (const decision of ws.decisions) {
      lines.push(`- ${decision.summary}${decision.rationale ? ` — ${decision.rationale}` : ""}`);
    }
  }
  if (ws.open_loops.length) {
    lines.push("Open loops:");
    for (const loop of ws.open_loops) {
      lines.push(`- ${loop.summary}${loop.priority ? ` (${loop.priority})` : ""}`);
    }
  }
  if (ws.file_anchors.length) {
    lines.push("File anchors:");
    for (const anchor of ws.file_anchors) {
      lines.push(`- ${anchor.path}${anchor.note ? `: ${anchor.note}` : ""}`);
    }
  }
  if (ws.constraints.length) {
    lines.push("Constraints:");
    for (const constraint of ws.constraints) lines.push(`- ${constraint}`);
  }
  if (ws.known_pitfalls.length) {
    lines.push("Known pitfalls:");
    for (const pitfall of ws.known_pitfalls) lines.push(`- ${pitfall}`);
  }
  if (lines.length === 0) return undefined;
  lines.push("This summary is a lossy extract of session text, not a full transcript.");
  return lines.join("\n");
}

function fillListField<T>(
  sections: Map<WorkField, string>,
  field: WorkField,
  _workState: WorkState,
  filledFields: WorkField[],
  blockedFields: WorkField[],
  structuredFields: WorkField[],
  emptySections: WorkField[],
  heuristicFields: WorkField[],
  heuristic: () => T[],
  assign: (items: T[]) => void,
  parse: (body: string) => T[],
): void {
  if (sections.has(field)) {
    const items = parse(sections.get(field) ?? "").slice(0, MAX_ITEMS);
    if (items.length) {
      assign(items);
      filledFields.push(field);
      structuredFields.push(field);
    } else {
      blockedFields.push(field);
      emptySections.push(field);
    }
    return;
  }
  const items = heuristic().slice(0, MAX_ITEMS);
  if (items.length) {
    assign(items);
    filledFields.push(field);
    heuristicFields.push(field);
  }
}

interface Block {
  heading?: string;
  body: string;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [{ body: "" }];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ heading: normalizeHeading(heading[1] ?? ""), body: "" });
    } else {
      blocks[blocks.length - 1]!.body += `${line}\n`;
    }
  }
  return blocks;
}

function normalizeHeading(raw: string): string {
  return raw.trim().replace(/[:：]\s*$/, "").replace(/\s+/g, " ").toLowerCase();
}

function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "\n");
}

function heuristicGoal(
  messages: { role: string; content: string }[],
  corpus: string[],
): string | undefined {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  if (firstUser) return firstUnlabeledLine(stripFences(firstUser.content));
  for (const part of corpus) {
    const line = firstUnlabeledLine(part);
    if (line) return line;
  }
  return undefined;
}

function firstUnlabeledLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > MAX_LINE) continue;
    if (/^#{1,3}\s+/.test(line)) continue;
    if (matchingRule(line)) continue;
    return clip(line, MAX_GOAL);
  }
  return undefined;
}

function matchingRule(line: string): { field: WorkField; value: string } | undefined {
  if (line.length > MAX_LINE) return undefined;
  for (const rule of LINE_RULES) {
    const match = line.match(rule.re);
    if (match?.[1]) return { field: rule.field, value: match[1].trim() };
  }
  return undefined;
}

function labeled(corpus: string[], field: WorkField): string[] {
  const out: string[] = [];
  for (const part of corpus) {
    for (const raw of part.split(/\r?\n/)) {
      const hit = matchingRule(raw.trim());
      if (hit?.field === field) out.push(clip(hit.value, MAX_ITEM));
    }
  }
  return dedupe(out);
}

function decisionsFrom(corpus: string[]): WorkStateDecision[] {
  return dedupeBy(
    labeled(corpus, "decisions").map(parseDecision),
    (item) => item.summary,
  );
}

function loopsFrom(corpus: string[]): WorkStateOpenLoop[] {
  return dedupeBy(
    labeled(corpus, "open_loops").map(parseLoop),
    (item) => item.summary,
  );
}

function anchorsFrom(corpus: string[]): WorkStateFileAnchor[] {
  const found: WorkStateFileAnchor[] = [];
  for (const part of corpus) {
    for (const raw of part.split(/\r?\n/)) {
      const hit = matchingRule(raw.trim());
      if (hit?.field === "file_anchors") {
        const anchor = parseAnchorBullet(hit.value);
        if (anchor) found.push(anchor);
      }
    }
    for (const match of part.matchAll(/`([^`\n]+)`/g)) {
      const anchor = parseAnchorBullet(`\`${match[1] ?? ""}\``);
      if (anchor) found.push(anchor);
    }
  }
  return dedupeBy(found, (item) => item.path).slice(0, MAX_ITEMS);
}

function parseDecisions(body: string): WorkStateDecision[] {
  return dedupeBy(listItems(body).map(parseDecision).filter((item) => item.summary), (item) => item.summary);
}

function parseLoops(body: string): WorkStateOpenLoop[] {
  return dedupeBy(listItems(body).map(parseLoop).filter((item) => item.summary), (item) => item.summary);
}

function parseAnchors(items: string[]): WorkStateFileAnchor[] {
  const anchors: WorkStateFileAnchor[] = [];
  for (const item of items) {
    const anchor = parseAnchorBullet(item);
    if (anchor) anchors.push(anchor);
  }
  return dedupeBy(anchors, (item) => item.path);
}

function parseDecision(text: string): WorkStateDecision {
  const parts = text.split(/\s+[—–]\s+|\s+--\s+/);
  const summary = clip(parts[0]?.trim() ?? "", MAX_ITEM);
  const rationale = parts.slice(1).join(" — ").trim();
  return rationale ? { summary, rationale: clip(rationale, MAX_ITEM) } : { summary };
}

function parseLoop(text: string): WorkStateOpenLoop {
  let rest = text.trim();
  let status: WorkStateOpenLoop["status"];
  const statusMatch = rest.match(/^\[(open|blocked|done)\]\s*/i);
  if (statusMatch) {
    status = statusMatch[1]!.toLowerCase() as WorkStateOpenLoop["status"];
    rest = rest.slice(statusMatch[0].length);
  }
  let priority: WorkStateOpenLoop["priority"];
  const priorityMatch = rest.match(/\s*\((low|medium|high)\)\s*$/i);
  if (priorityMatch?.[1] && priorityMatch.index !== undefined) {
    priority = priorityMatch[1].toLowerCase() as WorkStateOpenLoop["priority"];
    rest = rest.slice(0, priorityMatch.index).trim();
  }
  const loop: WorkStateOpenLoop = { summary: clip(rest, MAX_ITEM) };
  if (status) loop.status = status;
  if (priority) loop.priority = priority;
  return loop;
}

function parseAnchorBullet(raw: string): WorkStateFileAnchor | undefined {
  const trimmed = raw.trim();
  const tick = trimmed.match(/^`([^`]+)`\s*(.*)$/);
  if (tick?.[1] && looksLikeRepoFile(tick[1])) {
    const note = tick[2]?.replace(/^[\s:：—–-]+/, "").trim();
    return note
      ? { path: cleanPath(tick[1]), note: clip(note, MAX_ITEM) }
      : { path: cleanPath(tick[1]) };
  }
  const split = trimmed.split(/\s+[—–]\s+|\s+--\s+/);
  if (split.length >= 2 && looksLikeRepoFile(split[0] ?? "")) {
    return {
      path: cleanPath(split[0] ?? ""),
      note: clip(split.slice(1).join(" — ").trim(), MAX_ITEM),
    };
  }
  const token = trimmed.replace(/^`|`$/g, "");
  if (looksLikeRepoFile(token)) return { path: cleanPath(token) };
  return undefined;
}

export function looksLikeRepoFile(token: string): boolean {
  const cleaned = cleanPath(token);
  if (cleaned.length < 3 || cleaned.length > 180) return false;
  if (/[?*{}]/.test(cleaned) || cleaned.includes("://")) return false;
  if (cleaned.includes("node_modules") || cleaned.includes(".git/")) return false;
  if (!/^(?:[A-Za-z]:)?[\w.@~/-]+\.[A-Za-z0-9]{1,8}$/.test(cleaned)) return false;
  if (!cleaned.includes("/")) {
    if (!/^[A-Za-z][\w.-]*\.[A-Za-z]{1,8}$/.test(cleaned)) return false;
  }
  return true;
}

function cleanPath(token: string): string {
  return token
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/\\/g, "/");
}

function listItems(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (match?.[1]) items.push(match[1].trim());
  }
  if (items.length) return items;
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trim();
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}
