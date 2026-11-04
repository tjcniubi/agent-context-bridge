import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { ExportOptions } from "../adapters/types.js";
import type { LossReportEntry, Transcript, TranscriptMessage } from "../protocol/types.js";
import { isDirectory, readTextCapped } from "../utils/fs.js";
import { loss } from "../utils/loss-report.js";
import { isInside, resolveInside } from "../utils/path-safety.js";
import {
  DEFAULT_TRANSCRIPT_MAX_BYTES,
  DEFAULT_TRANSCRIPT_MAX_MESSAGES,
  PLAINTEXT_EXTENSIONS,
} from "./limits.js";
import { parsePlaintextTranscript, parseTranscriptJsonl, type JsonlParseResult, type ParseLimits } from "./parse.js";

const LOSSY_NOTE =
  "Lossy transcript. Attachments are omitted, tool results may be truncated, and unknown fields are listed on each message. Nothing here is injected into a chat UI.";

export function cursorProjectSlugs(projectRoot: string): string[] {
  const slash = resolve(projectRoot).replace(/\\/g, "/");
  const variants = new Set<string>();
  const add = (value: string) => {
    variants.add(value);
    variants.add(value.startsWith("-") ? value.slice(1) : `-${value}`);
  };
  add(slash.replace(/\//g, "-"));
  add(slash.replace(/:/g, "").replace(/\//g, "-"));
  add(slash.replace(/:/g, "-").replace(/\//g, "-"));
  return [...variants].filter((value) => value.length > 0);
}

/** Database-backed chat stores are never opened. Trae's library is encrypted. */
export function isSealedStorePath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  if (norm.includes("/modulardata/")) return true;
  if (/(^|\/)(database|store)\.db$/.test(norm)) return true;
  return norm.endsWith(".db") || norm.endsWith(".sqlite") || norm.endsWith(".sqlite3");
}

function isPlaintextPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return PLAINTEXT_EXTENSIONS.includes(ext);
}

function isExplicitFile(session: string): boolean {
  return session.includes("/") || session.includes("\\") || isPlaintextPath(session);
}

interface SessionFile {
  id: string;
  file: string;
  mtimeMs: number;
  subagents: string[];
}

async function listSessions(transcriptsDir: string): Promise<SessionFile[]> {
  if (!(await isDirectory(transcriptsDir))) return [];
  let entries;
  try {
    entries = await readdir(transcriptsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: SessionFile[] = [];
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    const abs = join(transcriptsDir, ent.name);
    if (ent.isFile() && ent.name.endsWith(".jsonl") && !isSealedStorePath(abs)) {
      const info = await stat(abs);
      sessions.push({ id: ent.name.replace(/\.jsonl$/, ""), file: abs, mtimeMs: info.mtimeMs, subagents: [] });
      continue;
    }
    if (!ent.isDirectory()) continue;
    const nested = join(abs, `${ent.name}.jsonl`);
    let main: string | undefined;
    try {
      const info = await stat(nested);
      if (info.isFile()) main = nested;
    } catch {
      main = undefined;
    }
    if (!main) {
      let inner;
      try {
        inner = await readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      const top = inner.find((item) => item.isFile() && !item.isSymbolicLink() && item.name.endsWith(".jsonl"));
      if (top) main = join(abs, top.name);
    }
    if (!main || isSealedStorePath(main)) continue;
    const info = await stat(main);
    const subDir = join(abs, "subagents");
    const subagents: string[] = [];
    if (await isDirectory(subDir)) {
      const subs = await readdir(subDir, { withFileTypes: true });
      for (const sub of subs) {
        if (sub.isFile() && !sub.isSymbolicLink() && sub.name.endsWith(".jsonl")) {
          subagents.push(join(subDir, sub.name));
        }
      }
      subagents.sort();
    }
    sessions.push({ id: ent.name, file: main, mtimeMs: info.mtimeMs, subagents });
  }
  return sessions;
}

function limitsOf(opts: ExportOptions): ParseLimits {
  return {
    maxBytes: opts.transcriptMaxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES,
    maxMessages: opts.transcriptMaxMessages ?? DEFAULT_TRANSCRIPT_MAX_MESSAGES,
  };
}

interface Budget {
  limits: ParseLimits;
  messages: TranscriptMessage[];
  bytes: number;
  truncated: boolean;
  metadataLines: number;
  badLines: number;
  subagentsOmitted: number;
}

function pushParsed(budget: Budget, parsed: JsonlParseResult): void {
  for (const message of parsed.messages) {
    const size = Buffer.byteLength(message.content);
    if (budget.messages.length >= budget.limits.maxMessages || budget.bytes + size > budget.limits.maxBytes) {
      budget.truncated = true;
      return;
    }
    budget.messages.push(message);
    budget.bytes += size;
  }
  budget.metadataLines += parsed.metadataLines;
  budget.badLines += parsed.badLines;
  if (parsed.truncated) budget.truncated = true;
}

async function readJsonl(file: string, limits: ParseLimits, losses: LossReportEntry[]): Promise<JsonlParseResult | undefined> {
  if (isSealedStorePath(file)) {
    losses.push(loss("transcript.sealed_store", "Refused to open a database-backed chat store.", "error", file));
    return undefined;
  }
  const capped = await readTextCapped(file, limits.maxBytes);
  if (!capped) return undefined;
  const text = capped.truncated ? capped.text.slice(0, capped.text.lastIndexOf("\n")) : capped.text;
  return parseTranscriptJsonl(text, limits, capped.truncated);
}

function finish(
  budget: Budget,
  sessionId: string | undefined,
  losses: LossReportEntry[],
  extraNotes: string[],
): Transcript | undefined {
  if (budget.messages.length === 0) return undefined;
  if (budget.truncated) {
    losses.push(
      loss(
        "transcript.truncated",
        `Transcript hit the size cap (${budget.limits.maxBytes} bytes / ${budget.limits.maxMessages} messages). Later messages were dropped.`,
        "warn",
      ),
    );
  }
  if (budget.metadataLines > 0) {
    losses.push(
      loss(
        "transcript.metadata_dropped",
        `Dropped ${budget.metadataLines} non-message JSONL line(s) (turn markers and similar).`,
        "info",
      ),
    );
  }
  if (budget.badLines > 0) {
    losses.push(
      loss("transcript.bad_lines", `Skipped ${budget.badLines} JSONL line(s) that were not valid JSON or messages.`, "warn"),
    );
  }
  if (budget.subagentsOmitted > 0) {
    losses.push(
      loss(
        "transcript.subagents_omitted",
        `Left out ${budget.subagentsOmitted} subagent JSONL file(s) after the size cap.`,
        "warn",
      ),
    );
  }
  const dropped = budget.messages.some((message) => (message.dropped_fields?.length ?? 0) > 0);
  if (dropped) {
    losses.push(
      loss(
        "transcript.fields_dropped",
        "Some messages dropped tool results, attachments, or unknown fields. See each message's dropped_fields.",
        "info",
      ),
    );
  }
  const notes = [LOSSY_NOTE, ...extraNotes].join(" ");
  return {
    messages: budget.messages,
    ...(sessionId ? { source_session_id: sessionId } : {}),
    notes,
  };
}

async function loadExplicitFile(
  projectRoot: string,
  session: string,
  opts: ExportOptions,
  losses: LossReportEntry[],
): Promise<Transcript | undefined> {
  if (!isExplicitFile(session)) return undefined;
  if (isSealedStorePath(session)) {
    losses.push(
      loss(
        "transcript.sealed_store",
        "Refused to read an encrypted or database-backed chat store. Pass a plaintext export instead.",
        "error",
        session,
      ),
    );
    return undefined;
  }
  if (!isPlaintextPath(session)) {
    losses.push(
      loss(
        "transcript.unsupported_file",
        "Session paths must be a session id or a plaintext file (.md, .txt, .json, .jsonl).",
        "warn",
        session,
      ),
    );
    return undefined;
  }
  const abs = resolve(projectRoot, session);
  const insideProject = isInside(resolve(projectRoot), abs);
  if (!insideProject && opts.allowExternalTranscriptFile === false) {
    losses.push(
      loss(
        "transcript.path_rejected",
        "Refused a transcript path outside the project. Place the export in .acb/imports/ or pass it to the CLI.",
        "warn",
        session,
      ),
    );
    return undefined;
  }
  const capped = await readTextCapped(abs, opts.transcriptMaxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES);
  if (!capped) {
    losses.push(loss("transcript.file_missing", "Plaintext transcript path was not found.", "warn", session));
    return undefined;
  }
  const limits = limitsOf(opts);
  const parsed = parsePlaintextTranscript(capped.truncated ? capped.text : capped.text, limits);
  if (capped.truncated) parsed.truncated = true;
  const budget: Budget = {
    limits,
    messages: [],
    bytes: 0,
    truncated: false,
    metadataLines: 0,
    badLines: 0,
    subagentsOmitted: 0,
  };
  pushParsed(budget, parsed);
  const unstructured = budget.messages.length === 1 && budget.messages[0]?.role === "user" && !session.endsWith(".jsonl") && !session.endsWith(".json");
  return finish(budget, basename(session), losses, [
    unstructured ? "Unstructured plaintext was kept as a single message." : "Read from a plaintext export.",
  ]);
}

async function loadCursorSessions(
  opts: ExportOptions,
  losses: LossReportEntry[],
): Promise<Transcript | undefined> {
  const home = opts.userHome ?? homedir();
  const projects = join(home, ".cursor", "projects");
  const projectsAbs = await resolveInside(home, ".cursor/projects");
  if (!projectsAbs || !(await isDirectory(projects))) return undefined;
  let entries;
  try {
    entries = await readdir(projects, { withFileTypes: true });
  } catch {
    losses.push(loss("transcript.cursor_unreadable", "Could not list ~/.cursor/projects.", "warn", ".cursor/projects"));
    return undefined;
  }
  const slugs = new Set(cursorProjectSlugs(opts.projectRoot));
  const matched: string[] = [];
  const others: string[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    const dir = join(projects, ent.name);
    const resolved = await resolveInside(home, `.cursor/projects/${ent.name}`);
    if (!resolved) {
      losses.push(loss("user_scope.symlink_skipped", "Skipped a Cursor project directory whose symlink escapes the home directory.", "warn", ent.name));
      continue;
    }
    if (slugs.has(ent.name)) matched.push(resolved);
    else others.push(resolved);
  }

  const sessionId = opts.sessionId?.trim();
  const pools = sessionId ? [matched, others] : [matched];
  let mismatch = false;
  for (const [index, pool] of pools.entries()) {
    const found: SessionFile[] = [];
    for (const dir of pool) {
      const sessions = await listSessions(join(dir, "agent-transcripts"));
      for (const session of sessions) {
        if (!sessionId || session.id === sessionId || basename(session.file, ".jsonl") === sessionId) {
          found.push(session);
        }
      }
    }
    if (found.length === 0) continue;
    if (index > 0) mismatch = true;
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const chosen = found[0];
    if (found.length > 1 && !sessionId) {
      losses.push(
        loss(
          "transcript.session_selected",
          `Exported the newest session ${chosen.id}. ${found.length - 1} other session(s) under this project were left out. Pass --session to choose one.`,
          "info",
          chosen.id,
        ),
      );
    }
    if (mismatch) {
      losses.push(
        loss(
          "transcript.session_slug_mismatch",
          `Session ${chosen.id} was found under a Cursor project slug that does not match this path. Slugs are not a stable API.`,
          "warn",
          chosen.id,
        ),
      );
    }
    const limits = limitsOf(opts);
    const budget: Budget = {
      limits,
      messages: [],
      bytes: 0,
      truncated: false,
      metadataLines: 0,
      badLines: 0,
      subagentsOmitted: 0,
    };
    const main = await readJsonl(chosen.file, limits, losses);
    if (main) pushParsed(budget, main);
    for (const sub of chosen.subagents) {
      if (budget.truncated || budget.messages.length >= limits.maxMessages) {
        budget.subagentsOmitted += 1;
        continue;
      }
      const label: TranscriptMessage = { role: "system", content: `[subagent] ${basename(sub, ".jsonl")}` };
      const size = Buffer.byteLength(label.content);
      if (budget.bytes + size > limits.maxBytes) {
        budget.truncated = true;
        budget.subagentsOmitted += 1;
        continue;
      }
      budget.messages.push(label);
      budget.bytes += size;
      const parsed = await readJsonl(sub, limits, losses);
      if (parsed) pushParsed(budget, parsed);
    }
    return finish(budget, chosen.id, losses, ["Read from Cursor agent-transcripts JSONL."]);
  }
  return undefined;
}

const TRAE_FILES = [
  ".acb/imports/transcript.md",
  ".acb/imports/transcript.txt",
  ".acb/imports/transcript.json",
  ".acb/imports/transcript.jsonl",
];

async function loadTraePlaintext(opts: ExportOptions, losses: LossReportEntry[]): Promise<Transcript | undefined> {
  const candidates: { abs: string; rel: string; mtimeMs: number }[] = [];
  for (const rel of TRAE_FILES) {
    const abs = await resolveInside(opts.projectRoot, rel);
    if (!abs || isSealedStorePath(abs)) continue;
    try {
      const info = await stat(abs);
      if (info.isFile()) candidates.push({ abs, rel, mtimeMs: info.mtimeMs });
    } catch {
      // missing candidate
    }
  }
  for (const dirRel of [".acb/imports", ".trae/exports"]) {
    const dir = await resolveInside(opts.projectRoot, dirRel);
    if (!dir || !(await isDirectory(dir))) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || ent.isSymbolicLink()) continue;
      if (!isPlaintextPath(ent.name)) continue;
      if (ent.name === "TRANSCRIPT.md" || ent.name === "WORK_STATE.md") continue;
      const rel = `${dirRel}/${ent.name}`;
      if (candidates.some((item) => item.rel === rel)) continue;
      const abs = join(dir, ent.name);
      if (isSealedStorePath(abs)) continue;
      const info = await stat(abs);
      candidates.push({ abs, rel, mtimeMs: info.mtimeMs });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = candidates[0];
  if (candidates.length > 1) {
    losses.push(
      loss(
        "transcript.multiple_exports",
        `Read ${chosen.rel}. ${candidates.length - 1} other plaintext export(s) were left out.`,
        "info",
        chosen.rel,
      ),
    );
  }
  const limits = limitsOf(opts);
  const capped = await readTextCapped(chosen.abs, limits.maxBytes);
  if (!capped) return undefined;
  const parsed = parsePlaintextTranscript(capped.text, limits);
  if (capped.truncated) parsed.truncated = true;
  const budget: Budget = {
    limits,
    messages: [],
    bytes: 0,
    truncated: false,
    metadataLines: 0,
    badLines: 0,
    subagentsOmitted: 0,
  };
  pushParsed(budget, parsed);
  return finish(budget, basename(chosen.rel), losses, [`Read Trae plaintext export ${chosen.rel}.`]);
}

export async function collectTranscript(
  agent: "cursor" | "trae",
  opts: ExportOptions,
): Promise<{ transcript?: Transcript; losses: LossReportEntry[] }> {
  const losses: LossReportEntry[] = [];
  const session = opts.sessionId?.trim();
  if (session && isSealedStorePath(session)) {
    losses.push(
      loss(
        agent === "trae" ? "transcript.trae_encrypted" : "transcript.sealed_store",
        agent === "trae"
          ? "Refused to open Trae's encrypted chat database. Pass a plaintext Export Chat file instead."
          : "Refused to open a database-backed chat store. Pass a JSONL or plaintext export instead.",
        "error",
        session,
      ),
    );
    return { losses };
  }
  if (session && isExplicitFile(session)) {
    const explicit = await loadExplicitFile(opts.projectRoot, session, opts, losses);
    if (explicit) {
      if (agent === "trae") {
        losses.push(
          loss(
            "transcript.trae_encrypted",
            "Trae's encrypted chat database was not opened. This transcript came from a plaintext file only.",
            "info",
            session,
          ),
        );
      }
      return { transcript: explicit, losses };
    }
    if (losses.some((entry) => entry.code === "transcript.sealed_store" || entry.code === "transcript.path_rejected")) {
      return { losses };
    }
  }

  if (agent === "cursor") {
    const found = await loadCursorSessions(opts, losses);
    if (found) return { transcript: found, losses };
    losses.push(
      loss(
        "transcript.cursor_not_found",
        session
          ? `No readable JSONL for session ${session} under ~/.cursor/projects/<slug>/agent-transcripts/.`
          : "No Cursor agent-transcripts JSONL matched this project. Pass --session with an id or a plaintext path.",
        "warn",
        session,
      ),
    );
    return { losses };
  }

  const plain = await loadTraePlaintext(opts, losses);
  losses.push(
    loss(
      "transcript.trae_encrypted",
      "Trae chat history in ModularData/ai-agent/database.db is encrypted and was not opened. Put an Export Chat plaintext file in .acb/imports/transcript.md, or pass that file as --session.",
      plain ? "info" : "error",
    ),
  );
  if (!plain) {
    losses.push(
      loss(
        "transcript.trae_plaintext_missing",
        "No plaintext transcript was found in .acb/imports/ or .trae/exports/.",
        "warn",
      ),
    );
  }
  return { transcript: plain, losses };
}
