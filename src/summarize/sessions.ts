/**
 * Read Cursor JSONL and plaintext transcripts.
 * Trae chat databases are detected and left unread.
 */
import { open, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { LossReportEntry } from "../protocol/types.js";
import { loss } from "../utils/loss-report.js";
import { isDirectory } from "../utils/fs.js";

export interface SessionMessage {
  role: string;
  content: string;
  timestamp?: string;
  dropped: string[];
}

export interface SummarySource {
  kind: "cursor" | "trae" | "notes" | "file";
  path?: string;
  sessionId?: string;
  messages: number;
}

const DROP_TYPES = new Set([
  "tool_use",
  "tool_result",
  "tool_call",
  "image",
  "image_url",
  "file",
  "attachment",
  "thinking",
  "redacted_thinking",
]);

const TEXT_TYPES = new Set(["text", "output_text", "input_text"]);

const TRAE_DB_PATHS = [
  "Library/Application Support/Trae CN/ModularData/ai-agent/database.db",
  "Library/Application Support/Trae/ModularData/ai-agent/database.db",
  "Library/Application Support/TRAE SOLO CN/ModularData/ai-agent/database.db",
  ".config/Trae CN/ModularData/ai-agent/database.db",
  ".config/Trae/ModularData/ai-agent/database.db",
  "AppData/Roaming/Trae CN/ModularData/ai-agent/database.db",
  "AppData/Roaming/Trae/ModularData/ai-agent/database.db",
  "AppData/Roaming/TRAE SOLO CN/ModularData/ai-agent/database.db",
];

export function cursorProjectSlug(projectRoot: string): string {
  const abs = resolve(projectRoot).replace(/\\/g, "/");
  return abs.replace(/^\//, "").replace(/:/g, "").replace(/\//g, "-");
}

export function parseSessionJsonl(text: string): {
  messages: SessionMessage[];
  skippedLines: number;
  dropped: string[];
} {
  const messages: SessionMessage[] = [];
  const dropped = new Set<string>();
  let skippedLines = 0;
  const body = text.replace(/^\uFEFF/, "");
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      skippedLines += 1;
      continue;
    }
    const message = messageFromRecord(parsed as Record<string, unknown>, dropped);
    if (message) messages.push(message);
  }
  return { messages, skippedLines, dropped: [...dropped] };
}

export function parseTranscriptDocument(
  text: string,
  filename: string,
):
  | { kind: "messages"; messages: SessionMessage[]; skippedLines: number; dropped: string[] }
  | { kind: "notes"; text: string }
  | { kind: "error"; message: string } {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jsonl")) return { kind: "messages", ...parseSessionJsonl(text) };
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const looksJson = lower.endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson || lower.endsWith(".md") || lower.endsWith(".txt")) {
    return { kind: "notes", text };
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed) as unknown;
  } catch (err) {
    if (lower.endsWith(".json")) {
      return { kind: "error", message: `Could not parse ${filename}: ${(err as Error).message}` };
    }
    return { kind: "notes", text };
  }
  const records = recordsFromJson(data);
  if (!records) {
    return {
      kind: "error",
      message: `${filename} is JSON but not a message list. Pass a jsonl transcript or notes.`,
    };
  }
  const dropped = new Set<string>();
  const messages: SessionMessage[] = [];
  let skippedLines = 0;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      skippedLines += 1;
      continue;
    }
    const message = messageFromRecord(record as Record<string, unknown>, dropped);
    if (message) messages.push(message);
  }
  return { kind: "messages", messages, skippedLines, dropped: [...dropped] };
}

export async function loadCursorSessions(opts: {
  projectRoot: string;
  cursorHome: string;
  sessionId?: string;
  maxSessions: number;
  maxFileBytes: number;
}): Promise<{ messages: SessionMessage[]; losses: LossReportEntry[]; sources: SummarySource[] }> {
  const losses: LossReportEntry[] = [];
  const sources: SummarySource[] = [];
  const slug = cursorProjectSlug(opts.projectRoot);
  const projectsDir = join(opts.cursorHome, "projects");
  const located = await resolveCursorProjectDir(projectsDir, opts.projectRoot, slug);
  losses.push(...located.losses);
  if (!located.dir) return { messages: [], losses, sources };

  const transcriptsRoot = join(located.dir, "agent-transcripts");
  const collected = await collectSessionJsonl(transcriptsRoot);
  if (collected.skippedSubagents > 0) {
    losses.push(
      loss(
        "cursor.session.subagents_skipped",
        "Skipped subagent transcripts under subagents/. They are not merged into Work State.",
        "info",
        transcriptsRoot,
      ),
    );
  }
  let files = collected.files;
  if (opts.sessionId) {
    const id = opts.sessionId;
    files = files.filter((file) => basename(file) === `${id}.jsonl` || file.split(/[/\\]/).includes(id));
    if (files.length === 0) {
      losses.push(
        loss(
          "cursor.session.not_found",
          `No Cursor transcript matched session ${id} under ${transcriptsRoot}.`,
          "warn",
          id,
        ),
      );
      return { messages: [], losses, sources };
    }
  }
  if (files.length === 0) {
    losses.push(
      loss(
        "cursor.session.not_found",
        `No Cursor JSONL transcripts under ${transcriptsRoot}.`,
        "warn",
        transcriptsRoot,
      ),
    );
    return { messages: [], losses, sources };
  }

  const stamped = await Promise.all(
    files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs, size: (await stat(file)).size })),
  );
  stamped.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  const chosen = stamped.slice(0, opts.maxSessions);
  const ignored = stamped.length - chosen.length;
  if (ignored > 0) {
    losses.push(
      loss(
        "cursor.session.extra_ignored",
        `Read ${chosen.length} most recent Cursor session(s); left ${ignored} older session(s) unread.`,
        "info",
      ),
    );
  }
  chosen.sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));

  const messages: SessionMessage[] = [];
  for (const file of chosen) {
    if (file.size > opts.maxFileBytes) {
      losses.push(
        loss(
          "cursor.session.too_large",
          `Skipped ${file.file} (${file.size} bytes). Limit is ${opts.maxFileBytes}.`,
          "warn",
          file.file,
        ),
      );
      continue;
    }
    const text = await readText(file.file);
    const parsed = parseSessionJsonl(text);
    if (parsed.skippedLines > 0) {
      losses.push(
        loss(
          "summarize.jsonl.skipped_lines",
          `Skipped ${parsed.skippedLines} unreadable JSONL line(s).`,
          "warn",
          file.file,
        ),
      );
    }
    if (parsed.dropped.length > 0) {
      losses.push(
        loss(
          "summarize.tool_results_dropped",
          `Non-text parts were not recovered: ${parsed.dropped.join(", ")}.`,
          "warn",
          file.file,
        ),
      );
    }
    const sessionId = sessionIdFromPath(file.file);
    losses.push(
      loss(
        "cursor.session.used",
        `Read Cursor session ${sessionId}. Text only; this is not a full transcript recovery.`,
        "info",
        file.file,
      ),
    );
    sources.push({
      kind: "cursor",
      path: file.file,
      sessionId,
      messages: parsed.messages.length,
    });
    messages.push(...parsed.messages);
  }
  return { messages, losses, sources };
}

export async function probeTraeDatabases(homeDir: string): Promise<LossReportEntry[]> {
  const found: string[] = [];
  for (const rel of TRAE_DB_PATHS) {
    const full = join(homeDir, rel);
    try {
      const info = await stat(full);
      if (info.isFile()) found.push(full);
    } catch {
      // absent
    }
  }
  if (found.length === 0) {
    return [
      loss(
        "trae.transcript.unavailable",
        "No Trae plaintext chat export was provided, and no local Trae chat database was found at known paths. A plaintext Export Chat file can be passed with --transcript or --notes.",
        "info",
      ),
    ];
  }
  return found.map((path) =>
    loss(
      "transcript.trae_encrypted",
      "Trae chat database was left unread. It is treated as encrypted, and this tool does not decrypt it. Pass a plaintext export with --transcript or --notes.",
      "warn",
      path,
    ),
  );
}

async function resolveCursorProjectDir(
  projectsDir: string,
  projectRoot: string,
  slug: string,
): Promise<{ dir?: string; losses: LossReportEntry[] }> {
  const exact = join(projectsDir, slug);
  if (await isDirectory(exact)) return { dir: exact, losses: [] };
  if (!(await isDirectory(projectsDir))) {
    return {
      losses: [
        loss(
          "cursor.session.not_found",
          `No Cursor project transcripts under ${projectsDir} (looked for slug ${slug}).`,
          "warn",
          projectsDir,
        ),
      ],
    };
  }
  const base = basename(resolve(projectRoot));
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => name === slug || (base.length >= 1 && name.endsWith(`-${base}`)));
  if (candidates.length === 1) {
    return {
      dir: join(projectsDir, candidates[0]!),
      losses: [
        loss(
          "cursor.session.slug_fallback",
          `Exact slug ${slug} was missing; used ${candidates[0]}.`,
          "info",
          candidates[0],
        ),
      ],
    };
  }
  if (candidates.length > 1) {
    return {
      losses: [
        loss(
          "cursor.session.ambiguous_project",
          `Several Cursor project folders match ${base} (${candidates.join(", ")}). None were read.`,
          "warn",
          projectsDir,
        ),
      ],
    };
  }
  return {
    losses: [
      loss(
        "cursor.session.not_found",
        `No Cursor project folder matched slug ${slug} under ${projectsDir}.`,
        "warn",
        projectsDir,
      ),
    ],
  };
}

async function collectSessionJsonl(transcriptsRoot: string): Promise<{ files: string[]; skippedSubagents: number }> {
  const files: string[] = [];
  let skippedSubagents = 0;
  if (!(await isDirectory(transcriptsRoot))) return { files, skippedSubagents };
  const sessions = await readdir(transcriptsRoot, { withFileTypes: true });
  for (const entry of sessions) {
    const full = join(transcriptsRoot, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const children = await readdir(full, { withFileTypes: true });
    for (const child of children) {
      if (child.isDirectory() && child.name === "subagents") {
        skippedSubagents += 1;
        continue;
      }
      if (child.isFile() && child.name.endsWith(".jsonl")) {
        files.push(join(full, child.name));
      }
    }
  }
  return { files, skippedSubagents };
}

function sessionIdFromPath(file: string): string {
  return basename(file, ".jsonl");
}

async function readText(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function recordsFromJson(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as { messages?: unknown }).messages)) {
    return (data as { messages: unknown[] }).messages;
  }
  return undefined;
}

function messageFromRecord(record: Record<string, unknown>, dropped: Set<string>): SessionMessage | undefined {
  const nested = asRecord(record.message);
  const roleRaw = record.role ?? nested?.role ?? record.type;
  const role = typeof roleRaw === "string" ? roleRaw : "unknown";
  const localDropped = new Set<string>();
  const content = collectText(nested ?? record.content ?? record, localDropped);
  for (const name of localDropped) dropped.add(name);
  if (role === "tool" || role === "function") {
    dropped.add(role);
    return undefined;
  }
  const text = content.trim();
  if (!text) return localDropped.size > 0 ? undefined : undefined;
  const timestamp = stringField(record.timestamp) ?? stringField(record.createdAt) ?? stringField(nested?.timestamp);
  return {
    role,
    content: text,
    dropped: [...localDropped],
    ...(timestamp ? { timestamp } : {}),
  };
}

function collectText(value: unknown, dropped: Set<string>): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => collectText(item, dropped))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  if (type && DROP_TYPES.has(type)) {
    dropped.add(type);
    return "";
  }
  if (typeof record.text === "string" && (type === undefined || TEXT_TYPES.has(type))) {
    return record.text;
  }
  if (typeof record.content === "string") return record.content;
  if (record.content !== undefined) return collectText(record.content, dropped);
  if (record.message !== undefined) return collectText(record.message, dropped);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
