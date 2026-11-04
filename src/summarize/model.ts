/**
 * Optional OpenAI-compatible Work State draft.
 * The caller decides whether drafting is on. Failures return loss entries
 * and never include the API key. Writing the bundle stays with the caller.
 */
import { readFile, stat } from "node:fs/promises";
import type { LossReportEntry, WorkState } from "../protocol/types.js";
import { loss } from "../utils/loss-report.js";
import type { ExtractOutput, WorkField } from "./extract.js";
import { normalizeWorkState } from "./normalize.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const CONFIG_MAX_BYTES = 64 * 1024;
const SOURCE_CAP = 24_000;
const SECRET_MIN = 8;

const SUMMARIZE_SYSTEM = [
  "You draft an Agent Work State from notes and session text.",
  "Return one JSON object and nothing else.",
  "Use only facts present in the source. Do not invent files, decisions, or goals.",
  "Do not copy secrets, API keys, tokens, or credentials. Replace them with [REDACTED].",
  "Schema:",
  "{",
  '  "goal": "string, optional",',
  '  "decisions": [{"summary": "string", "rationale": "string, optional"}],',
  '  "open_loops": [{"summary": "string", "priority": "low|medium|high, optional", "status": "open|blocked|done, optional"}],',
  '  "file_anchors": [{"path": "repo-relative path", "note": "string, optional"}],',
  '  "constraints": ["string"],',
  '  "known_pitfalls": ["string"],',
  '  "last_summary": "short lossy summary, not a full transcript"',
  "}",
  "Omit empty fields. This is a lossy extract, not a transcript.",
].join("\n");

const REPAIR_SYSTEM = [
  "You turn one repair answer into a Work State patch.",
  "Return one JSON object and nothing else.",
  "Use only the user's answer and the loss context. Do not invent facts that are not in them.",
  "Do not copy secrets, API keys, tokens, or credentials. Replace them with [REDACTED].",
  "Schema:",
  "{",
  '  "goal": "string, optional",',
  '  "last_summary": "string, optional",',
  '  "decisions": [{"summary": "string", "rationale": "string, optional"}],',
  '  "open_loops": [{"summary": "string", "priority": "low|medium|high, optional", "status": "open|blocked|done, optional"}],',
  '  "file_anchors": [{"path": "string", "note": "string, optional"}],',
  '  "constraints": ["string"],',
  '  "known_pitfalls": ["string"]',
  "}",
  "Omit empty fields.",
].join("\n");

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface ModelToggle {
  enabled: boolean;
  /** Overrides ACB_MODEL and the config file. */
  model?: string;
  /** Overrides ACB_MODEL_BASE_URL and the config file. */
  baseUrl?: string;
  /** JSON file with model, baseUrl, and optional apiKey. */
  configPath?: string;
  /** When set, process.env is not consulted. */
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface ResolvedModel {
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
}

export type WorkStateDraft =
  | { ok: true; workState: WorkState; losses: LossReportEntry[] }
  | { ok: false; losses: LossReportEntry[] };

export type SummarizeDraft =
  | { ok: true; extracted: ExtractOutput; losses: LossReportEntry[] }
  | { ok: false; losses: LossReportEntry[] };

interface FileConfig {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < SECRET_MIN || !out.includes(trimmed)) continue;
    out = out.split(trimmed).join("[REDACTED]");
  }
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]");
  out = out.replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, "$1[REDACTED]");
  out = out.replace(
    /((?:api[_-]?key|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
    "$1[REDACTED]",
  );
  return out;
}

export function modelFailedEntry(reason: string, secrets: readonly string[] = []): LossReportEntry {
  const safe = redactSecrets(reason, secrets).replace(/\s+/g, " ").trim().slice(0, 400);
  return loss(
    "work_state.model_failed",
    `External model draft failed (${safe || "unknown error"}). Fell back to the rule-based extract.`,
    "warn",
  );
}

export function modelDraftedEntry(input: {
  model: string;
  host: string;
  secrets?: readonly string[];
  trimmed?: boolean;
  redacted?: boolean;
}): LossReportEntry {
  const parts = [
    `External model ${input.model} at ${input.host} drafted Work State.`,
    "Rule-based extract was not used.",
    "This is a lossy extract, not a full transcript.",
  ];
  if (input.trimmed) parts.push("Source text sent to the model was trimmed.");
  if (input.redacted) parts.push("Sensitive tokens were replaced with [REDACTED].");
  return loss(
    "work_state.model_drafted",
    redactSecrets(parts.join(" "), input.secrets ?? []).slice(0, 500),
    "info",
  );
}

export async function draftWorkState(
  toggle: ModelToggle,
  input: { notes: string[]; messages: { role: string; content: string }[] },
): Promise<SummarizeDraft> {
  try {
    const resolved = await resolveModel(toggle);
    if (!resolved.ok) return { ok: false, losses: [modelFailedEntry(resolved.reason)] };
    const source = buildSource(input.notes, input.messages, resolved.model.apiKey);
    const completion = await chat(resolved.model, SUMMARIZE_SYSTEM, source.text);
    if (!completion.ok) return fail(completion.reason, resolved.model.apiKey);
    const interpreted = interpretContent(completion.content, resolved.model.apiKey);
    if (!interpreted.ok) return fail(interpreted.reason, resolved.model.apiKey);
    return {
      ok: true,
      extracted: toExtractOutput(interpreted.workState),
      losses: [
        modelDraftedEntry({
          model: resolved.model.model,
          host: hostOf(resolved.model.baseUrl),
          secrets: [resolved.model.apiKey],
          trimmed: source.trimmed,
          redacted: source.redacted || interpreted.redacted,
        }),
      ],
    };
  } catch {
    return fail("unexpected model client error");
  }
}

export async function draftRepairPatch(
  toggle: ModelToggle,
  input: { code: string; message: string; path?: string; answer: string },
): Promise<WorkStateDraft> {
  try {
    const resolved = await resolveModel(toggle);
    if (!resolved.ok) return { ok: false, losses: [modelFailedEntry(resolved.reason)] };
    const prompt = buildRepairPrompt(input, resolved.model.apiKey);
    const completion = await chat(resolved.model, REPAIR_SYSTEM, prompt.text);
    if (!completion.ok) return fail(completion.reason, resolved.model.apiKey);
    const interpreted = interpretContent(completion.content, resolved.model.apiKey);
    if (!interpreted.ok) return fail(interpreted.reason, resolved.model.apiKey);
    return {
      ok: true,
      workState: interpreted.workState,
      losses: [
        modelDraftedEntry({
          model: resolved.model.model,
          host: hostOf(resolved.model.baseUrl),
          secrets: [resolved.model.apiKey],
          trimmed: prompt.trimmed,
          redacted: prompt.redacted || interpreted.redacted,
        }),
      ],
    };
  } catch {
    return fail("unexpected model client error");
  }
}

function fail(reason: string, secret?: string): { ok: false; losses: LossReportEntry[] } {
  return { ok: false, losses: [modelFailedEntry(reason, secret ? [secret] : [])] };
}

async function resolveModel(
  toggle: ModelToggle,
): Promise<{ ok: true; model: ResolvedModel } | { ok: false; reason: string }> {
  const env = toggle.env ?? process.env;
  const configPath = firstString(toggle.configPath, env.ACB_MODEL_CONFIG);
  let file: FileConfig = {};
  if (configPath) {
    const loaded = await readConfig(configPath);
    if (!loaded.ok) return loaded;
    file = loaded.value;
  }
  const model = firstString(toggle.model, file.model, env.ACB_MODEL);
  const baseUrl = firstString(toggle.baseUrl, file.baseUrl, env.ACB_MODEL_BASE_URL) ?? DEFAULT_BASE_URL;
  const apiKey = firstString(env.ACB_MODEL_API_KEY, file.apiKey);
  if (!model) return { ok: false, reason: "model id is not set" };
  if (!apiKey) return { ok: false, reason: "API key is not set" };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, reason: "model base URL is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "model base URL must be http or https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "model base URL must not include credentials" };
  }
  parsed.search = "";
  parsed.hash = "";
  const base = parsed.toString().replace(/\/+$/, "");
  return {
    ok: true,
    model: {
      model: model.slice(0, 200),
      baseUrl: base,
      apiKey,
      timeoutMs: timeoutOf(toggle.timeoutMs ?? env.ACB_MODEL_TIMEOUT_MS),
      fetchImpl: toggle.fetchImpl ?? globalThis.fetch,
    },
  };
}

async function readConfig(
  file: string,
): Promise<{ ok: true; value: FileConfig } | { ok: false; reason: string }> {
  let raw: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) return { ok: false, reason: "model config file was not found" };
    if (info.size > CONFIG_MAX_BYTES) return { ok: false, reason: "model config file is too large" };
    raw = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "model config file was not found" };
    return { ok: false, reason: "model config file could not be read" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "model config is not valid JSON" };
  }
  const row = asObject(data);
  if (!row) return { ok: false, reason: "model config must be a JSON object" };
  return {
    ok: true,
    value: {
      model: cleanConfigString(row.model),
      baseUrl: cleanConfigString(row.baseUrl) ?? cleanConfigString(row.base_url),
      apiKey: cleanConfigString(row.apiKey) ?? cleanConfigString(row.api_key),
    },
  };
}

async function chat(
  resolved: ResolvedModel,
  system: string,
  user: string,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const first = await post(resolved, {
    model: resolved.model,
    temperature: 0,
    max_tokens: 2048,
    response_format: { type: "json_object" },
    messages,
  });
  if (first.ok) return contentFrom(first.raw, resolved.apiKey);
  if (!first.retryable) return { ok: false, reason: first.reason };
  const second = await post(resolved, { model: resolved.model, messages });
  if (!second.ok) return { ok: false, reason: second.reason };
  return contentFrom(second.raw, resolved.apiKey);
}

async function post(
  resolved: ResolvedModel,
  body: unknown,
): Promise<{ ok: true; raw: string } | { ok: false; reason: string; retryable: boolean }> {
  const url = chatUrl(resolved.baseUrl);
  try {
    const response = await resolved.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolved.timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        retryable: (response.status === 400 || response.status === 422) && retryableBody(raw),
        reason: httpReason(response.status, raw, resolved.apiKey),
      };
    }
    return { ok: true, raw };
  } catch (err) {
    return { ok: false, retryable: false, reason: networkReason(err, resolved.apiKey) };
  }
}

function contentFrom(
  raw: string,
  apiKey: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "model response was not JSON" };
  }
  const row = asObject(payload);
  const error = asObject(row?.error);
  if (error) {
    const message = typeof error.message === "string" ? error.message : "model returned an error";
    return { ok: false, reason: httpReason(200, message, apiKey) };
  }
  const choice = Array.isArray(row?.choices) ? asObject(row.choices[0]) : undefined;
  const message = asObject(choice?.message);
  const content = messageContent(message?.content);
  if (!content.trim()) return { ok: false, reason: "model response had no content" };
  return { ok: true, content };
}

function interpretContent(
  content: string,
  apiKey: string,
): { ok: true; workState: WorkState; redacted: boolean } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = parseModelJson(content);
  } catch {
    return { ok: false, reason: "model response was not JSON" };
  }
  let workState: WorkState;
  try {
    workState = normalizeWorkState(coerceWorkState(value));
  } catch {
    return { ok: false, reason: "model Work State failed validation" };
  }
  const scrubbed = scrubWorkState(workState, [apiKey]);
  if (!hasContent(scrubbed.workState)) return { ok: false, reason: "model returned an empty Work State" };
  return { ok: true, workState: scrubbed.workState, redacted: scrubbed.redacted };
}

function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = (fence?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1)) as unknown;
    throw new Error("model response was not JSON");
  }
}

function coerceWorkState(value: unknown): unknown {
  const row = asObject(unwrapWorkState(value));
  if (!row) return value;
  return {
    ...row,
    decisions: coerceItems(row.decisions, "decision"),
    open_loops: coerceItems(row.open_loops, "loop"),
    file_anchors: coerceItems(row.file_anchors, "anchor"),
    constraints: coerceItems(row.constraints, "string"),
    known_pitfalls: coerceItems(row.known_pitfalls, "string"),
  };
}

function unwrapWorkState(value: unknown): unknown {
  const row = asObject(value);
  if (!row) return value;
  if (row.work_state && typeof row.work_state === "object") return row.work_state;
  if (row.workState && typeof row.workState === "object") return row.workState;
  return row;
}

function coerceItems(value: unknown, kind: "decision" | "loop" | "anchor" | "string"): unknown {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return value;
  return list.map((item) => {
    if (typeof item !== "string") return item;
    const text = item.trim();
    if (!text) return item;
    if (kind === "string") return text;
    if (kind === "decision") return { summary: text };
    if (kind === "loop") return { summary: text, status: "open" };
    return { path: text };
  });
}

function scrubWorkState(ws: WorkState, secrets: string[]): { workState: WorkState; redacted: boolean } {
  const flag = { redacted: false };
  const goal = scrub(ws.goal, secrets, flag);
  const last = scrub(ws.last_summary, secrets, flag);
  const decisions = ws.decisions.flatMap((item) => {
    const summary = scrub(item.summary, secrets, flag);
    if (!summary) return [];
    const rationale = scrub(item.rationale, secrets, flag);
    const decidedAt = scrub(item.decided_at, secrets, flag);
    return [{
      summary,
      ...(rationale ? { rationale } : {}),
      ...(decidedAt ? { decided_at: decidedAt } : {}),
    }];
  });
  const openLoops = ws.open_loops.flatMap((item) => {
    const summary = scrub(item.summary, secrets, flag);
    if (!summary) return [];
    return [{
      summary,
      ...(item.priority ? { priority: item.priority } : {}),
      ...(item.status ? { status: item.status } : {}),
    }];
  });
  const anchors = ws.file_anchors.flatMap((item) => {
    const path = scrub(item.path, secrets, flag);
    if (!path) return [];
    const note = scrub(item.note, secrets, flag);
    return [{ path, ...(note ? { note } : {}) }];
  });
  const constraints = ws.constraints.flatMap((item) => {
    const next = scrub(item, secrets, flag);
    return next ? [next] : [];
  });
  const pitfalls = ws.known_pitfalls.flatMap((item) => {
    const next = scrub(item, secrets, flag);
    return next ? [next] : [];
  });
  return {
    redacted: flag.redacted,
    workState: {
      ...(goal ? { goal } : {}),
      ...(last ? { last_summary: last } : {}),
      decisions,
      open_loops: openLoops,
      file_anchors: anchors,
      constraints,
      known_pitfalls: pitfalls,
    },
  };
}

function scrub(value: string | undefined, secrets: string[], flag: { redacted: boolean }): string | undefined {
  if (!value) return undefined;
  const next = redactSecrets(value, secrets).trim();
  if (next !== value.trim()) flag.redacted = true;
  return next || undefined;
}

function toExtractOutput(ws: WorkState): ExtractOutput {
  const filledFields: WorkField[] = [];
  if (ws.goal) filledFields.push("goal");
  if (ws.decisions.length) filledFields.push("decisions");
  if (ws.open_loops.length) filledFields.push("open_loops");
  if (ws.file_anchors.length) filledFields.push("file_anchors");
  if (ws.constraints.length) filledFields.push("constraints");
  if (ws.known_pitfalls.length) filledFields.push("known_pitfalls");
  const summaryMode: ExtractOutput["summaryMode"] = ws.last_summary
    ? "structured"
    : filledFields.length > 0
      ? "compose"
      : "none";
  return {
    workState: ws,
    filledFields,
    blockedFields: [],
    summaryMode,
    heuristicFields: [],
    structuredFields: [],
    emptySections: [],
  };
}

function buildSource(
  notes: string[],
  messages: { role: string; content: string }[],
  apiKey: string,
): { text: string; trimmed: boolean; redacted: boolean } {
  const parts: string[] = [];
  let redacted = false;
  if (notes.some((note) => note.trim())) {
    parts.push("# Notes");
    for (const note of notes) {
      const safe = redactSecrets(note, [apiKey]);
      if (safe !== note) redacted = true;
      parts.push(safe);
    }
  }
  if (messages.length) {
    parts.push("# Session messages");
    for (const message of messages) {
      const safe = redactSecrets(message.content, [apiKey]);
      if (safe !== message.content) redacted = true;
      parts.push(`[${message.role}]\n${safe}`);
    }
  }
  return capText(parts.join("\n\n"), redacted);
}

function buildRepairPrompt(
  input: { code: string; message: string; path?: string; answer: string },
  apiKey: string,
): { text: string; trimmed: boolean; redacted: boolean } {
  const secrets = [apiKey];
  const message = redactSecrets(input.message, secrets);
  const answer = redactSecrets(input.answer, secrets);
  const path = input.path ? redactSecrets(input.path, secrets) : undefined;
  const lines = [`Loss code: ${input.code}`, `Loss message: ${message}`];
  if (path) lines.push(`Path: ${path}`);
  lines.push("", "User answer:", answer);
  const redacted = message !== input.message || answer !== input.answer || path !== input.path;
  return capText(lines.join("\n"), redacted);
}

function capText(text: string, redacted: boolean): { text: string; trimmed: boolean; redacted: boolean } {
  if (text.length <= SOURCE_CAP) return { text, trimmed: false, redacted };
  const head = Math.floor(SOURCE_CAP * 0.25);
  const tail = SOURCE_CAP - head;
  return {
    text: `${text.slice(0, head)}\n\n[... trimmed ...]\n\n${text.slice(-tail)}`,
    trimmed: true,
    redacted,
  };
}

function chatUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}/chat/completions`;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

function httpReason(status: number, body: string, apiKey: string): string {
  const snippet = redactSecrets(body, [apiKey]).replace(/\s+/g, " ").trim().slice(0, 160);
  if (!snippet) return `HTTP ${status}`;
  return `HTTP ${status}: ${snippet}`;
}

function retryableBody(body: string): boolean {
  return /response_format|json_object|max_tokens|temperature|unsupported/i.test(body);
}

function networkReason(err: unknown, apiKey: string): string {
  if (isTimeout(err)) return "request timed out";
  const message = err instanceof Error ? err.message : "";
  const safe = redactSecrets(message, [apiKey]).replace(/\s+/g, " ").trim().slice(0, 180);
  if (!safe || safe === "fetch failed") return "network error";
  return `network error: ${safe}`;
}

function isTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  const code = "code" in err ? String(err.code) : "";
  return name === "TimeoutError" || name === "AbortError" || code === "ABORT_ERR";
}

function messageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const row = asObject(part);
      return typeof row?.text === "string" ? row.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function hasContent(ws: WorkState): boolean {
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

function timeoutOf(raw: string | number | undefined): number {
  const value = typeof raw === "number" ? raw : raw ? Number(raw) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function firstString(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function cleanConfigString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 2000) : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
