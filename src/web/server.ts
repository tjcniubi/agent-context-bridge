/**
 * Local-only HTTP server for the web UI.
 * Binds to loopback by default. API calls the same export/import/validate code as the CLI.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listAdapters } from "../adapters/index.js";
import { UserInputError } from "../core/errors.js";
import {
  applyTranscriptFile,
  convertProject,
  exportProject,
  importProject,
} from "../core/operations.js";
import type { AgentWorkBundle, LossReportEntry } from "../protocol/types.js";
import { validateBundle } from "../protocol/validate.js";
import {
  hasWorkStateContent,
  renderWorkStateMarkdown,
} from "../protocol/work-state-markdown.js";
import {
  RepairFlowError,
  answerCurrent,
  confirmProposals,
  draftAnswers,
  pendingIds,
  rejectProposals,
  reviseProposal,
  startRepair,
  toRepairView,
  type RepairSession,
} from "../repair/guide.js";
import { isDirectory, writeText } from "../utils/fs.js";
import {
  applyWorkState,
  mergeSummary,
  normalizeLosses,
  normalizeWorkState,
  parseAgent,
  summarizeSessions,
  summaryLossesFor,
  type TranscriptText,
} from "../summarize/run.js";
import { matchProjectDirectories, type LocateHint } from "./locate.js";

const MAX_BODY = 20 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function defaultWebDist(): string {
  return join(packageRoot(), "web", "dist");
}

export interface WebListenOptions {
  host: string;
  port: number;
  staticDir?: string;
  dev?: boolean;
}

interface ListenerOptions {
  staticDir?: string;
  sessions?: Map<string, RepairSession>;
  devHandler?: (req: IncomingMessage, res: ServerResponse) => void;
}

export function createRequestListener(options: ListenerOptions = {}) {
  const store = options.sessions ?? new Map<string, RepairSession>();

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await handleApi(req, res, url, store);
      if (handled) return;
      if (options.devHandler && (req.method === "GET" || req.method === "HEAD")) {
        options.devHandler(req, res);
        return;
      }
      await serveStatic(res, options.staticDir, url.pathname);
    } catch (err) {
      const mapped = mapError(err);
      sendJson(res, mapped.status, mapped.body);
    }
  };
}

export async function startWebServer(opts: WebListenOptions): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  let devHandler: ListenerOptions["devHandler"];
  let viteClose: (() => Promise<void>) | undefined;
  if (opts.dev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: join(packageRoot(), "web", "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    devHandler = (req, res) => {
      vite.middlewares(req, res, () => {
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end("Not found");
        }
      });
    };
    viteClose = () => vite.close();
  }

  const server = createServer(
    createRequestListener({
      staticDir: opts.staticDir ?? defaultWebDist(),
      devHandler,
    }),
  );

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolveListen());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const host = opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  return {
    url: `http://${host}:${port}`,
    close: async () => {
      if (viteClose) await viteClose();
      await new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: Map<string, RepairSession>,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (!path.startsWith("/api/")) return false;

  if (method === "GET" && path === "/api/health") {
    sendJson(res, 200, { ok: true, service: "agent-context-bridge", version: "0.1.0" });
    return true;
  }

  if (method === "GET" && path === "/api/adapters") {
    sendJson(res, 200, {
      adapters: listAdapters().map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        project: adapter.paths.project,
      })),
    });
    return true;
  }

  if (method === "GET" && path === "/api/fs/list") {
    const listed = await listDirs(url.searchParams.get("path") || process.cwd());
    sendJson(res, 200, listed);
    return true;
  }

  if (method === "POST" && path === "/api/export") {
    const body = await readJson(req);
    const project = requireString(body, "project");
    await assertDirectory(project);
    const result = await exportProject({
      agent: requireString(body, "agent"),
      project,
      includeUser: bool(body, "includeUser"),
      sessionId: optionalString(body, "sessionId"),
      includeTranscript: bool(body, "includeTranscript"),
      transcriptMaxBytes: optionalInt(body, "transcriptMaxBytes"),
      transcriptMaxMessages: optionalInt(body, "transcriptMaxMessages"),
      allowExternalTranscriptFile: false,
    });
    sendJson(res, 200, {
      bundle: result.bundle,
      losses: result.losses,
      summary: summarize(result.bundle, result.losses),
    });
    return true;
  }

  if (method === "POST" && path === "/api/import") {
    const body = await readJson(req);
    const project = requireString(body, "project");
    await assertDirectory(project);
    const result = await importProject({
      agent: requireString(body, "agent"),
      project,
      bundle: body.bundle,
      dryRun: bool(body, "dryRun"),
      includeUser: bool(body, "includeUser"),
    });
    const bundle = withLosses(result.bundle, result.losses);
    sendJson(res, 200, {
      bundle,
      losses: result.losses,
      written: result.written,
      changes: result.changes,
      dryRun: bool(body, "dryRun"),
      summary: summarize(bundle, result.losses),
    });
    return true;
  }

  if (method === "POST" && path === "/api/convert") {
    const body = await readJson(req);
    const project = requireString(body, "project");
    await assertDirectory(project);
    const result = await convertProject({
      from: requireString(body, "from"),
      to: requireString(body, "to"),
      project,
      dryRun: bool(body, "dryRun"),
      includeUser: bool(body, "includeUser"),
      includeTranscript: bool(body, "includeTranscript"),
      sessionId: optionalString(body, "sessionId"),
      transcriptMaxBytes: optionalInt(body, "transcriptMaxBytes"),
      transcriptMaxMessages: optionalInt(body, "transcriptMaxMessages"),
      allowExternalTranscriptFile: false,
      persistBundle: false,
    });
    const bundle = withLosses(result.bundle, result.importLosses);
    sendJson(res, 200, {
      bundle,
      losses: result.importLosses,
      exportLosses: result.exportLosses,
      written: result.written,
      changes: result.changes,
      dryRun: bool(body, "dryRun"),
      summary: summarize(bundle, result.importLosses),
    });
    return true;
  }

  if (method === "POST" && path === "/api/validate") {
    const body = await readJson(req);
    const check = validateBundle(body.bundle);
    if (!check.ok) {
      sendJson(res, 400, { ok: false, error: "Bundle failed validation:", details: check.errors });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      bundle: check.bundle,
      losses: check.bundle!.manifest.loss_report,
      summary: summarize(check.bundle!, check.bundle!.manifest.loss_report),
    });
    return true;
  }

  if (method === "POST" && path === "/api/transcript/apply") {
    const body = await readJson(req);
    if (body.confirm !== true) {
      throw new UserInputError("写入 transcript 需要 confirm: true。未确认不会写文件。");
    }
    const project = requireString(body, "project");
    await assertDirectory(project);
    const result = await applyTranscriptFile({
      project,
      bundle: body.bundle,
      dryRun: bool(body, "dryRun"),
    });
    sendJson(res, 200, result);
    return true;
  }

  if (method === "POST" && path === "/api/fs/match") {
    const body = await readJson(req);
    const found = await matchProjectDirectories({
      name: requireString(body, "name"),
      entries: stringList(body, "entries"),
      hint: parseHint(body.hint),
      roots: optionalStringList(body, "roots"),
    });
    sendJson(res, 200, found);
    return true;
  }

  if (method === "POST" && path === "/api/summarize/preview") {
    const body = await readJson(req);
    const project = requireString(body, "project");
    await assertDirectory(project);
    const existing = optionalBundle(body.bundle);
    const result = await summarizeSessions({
      projectRoot: project,
      agent: parseAgent(optionalString(body, "agent") ?? "both"),
      sessionId: optionalString(body, "sessionId"),
      notesText: optionalString(body, "notesText"),
      transcriptPaths: optionalStringList(body, "transcripts"),
      transcriptTexts: transcriptTexts(body),
      cursorHome: optionalString(body, "cursorHome"),
      homeDir: optionalString(body, "home"),
    });
    const losses = summaryLossesFor(existing?.work_state, result);
    sendJson(res, 200, {
      workState: mergeSummary(existing?.work_state, result),
      losses,
      sources: result.sources,
      sourceAgent: result.sourceAgent,
      summaryMode: result.summaryMode,
      applied: false,
    });
    return true;
  }

  if (method === "POST" && path === "/api/summarize/apply") {
    const body = await readJson(req);
    const existing = optionalBundle(body.bundle);
    const workState = normalizeWorkState(body.workState);
    const bundle = applyWorkState({
      existing,
      workState,
      summaryLosses: normalizeLosses(body.losses),
      projectRoot: optionalString(body, "project"),
      sourceAgent: optionalString(body, "sourceAgent") ?? existing?.manifest.source_agent,
      confirmed: true,
    });
    const check = validateBundle(bundle);
    if (!check.ok) throw new UserInputError("Bundle failed validation:", check.errors);
    const valid = check.bundle as AgentWorkBundle;
    sendJson(res, 200, {
      bundle: valid,
      losses: valid.manifest.loss_report,
      summary: summarize(valid, valid.manifest.loss_report),
      applied: true,
    });
    return true;
  }

  if (method === "POST" && path === "/api/work-state/write") {
    const body = await readJson(req);
    const project = requireString(body, "project");
    await assertDirectory(project);
    const check = validateBundle(body.bundle);
    if (!check.ok) throw new UserInputError("Bundle failed validation:", check.errors);
    const bundle = check.bundle as AgentWorkBundle;
    if (!hasWorkStateContent(bundle)) {
      throw new UserInputError("Work State 还是空的，没有可写的 sidecar。");
    }
    const rel = ".acb/WORK_STATE.md";
    const full = resolve(project, rel);
    assertInside(resolve(project), full);
    await writeText(full, renderWorkStateMarkdown(bundle));
    sendJson(res, 200, { written: rel });
    return true;
  }

  if (method === "POST" && path === "/api/repair/start") {
    const body = await readJson(req);
    const check = validateBundle(body.bundle);
    if (!check.ok) throw new UserInputError("Bundle failed validation:", check.errors);
    const id = crypto.randomUUID();
    const session = startRepair(check.bundle as AgentWorkBundle, id);
    store.set(id, session);
    sendJson(res, 200, toRepairView(session));
    return true;
  }

  const repair = path.match(
    /^\/api\/repair\/([A-Za-z0-9_-]+)(?:\/(answer|draft|confirm|reject|revise))?$/,
  );
  if (repair) {
    const id = repair[1];
    const action = repair[2];
    const session = store.get(id);
    if (!session) throw new HttpError(404, "修复会话不存在。请重新开始。");
    if (method === "GET" && !action) {
      sendJson(res, 200, toRepairView(session));
      return true;
    }
    if (method !== "POST" || !action) throw new HttpError(405, "不支持的方法。");
    const body = await readJson(req);
    const updated = applyRepairAction(session, action, body);
    store.set(id, updated);
    sendJson(res, 200, toRepairView(updated));
    return true;
  }

  throw new HttpError(404, `未知接口 ${path}`);
}

function applyRepairAction(session: RepairSession, action: string, body: JsonRecord): RepairSession {
  if (action === "answer") {
    if (typeof body.text !== "string") throw new RepairFlowError("请提供 text。");
    return answerCurrent(session, body.text);
  }
  if (action === "draft") {
    if (!Array.isArray(body.answers)) throw new RepairFlowError("请提供 answers。");
    const answers = body.answers.map((item) => {
      const row = asRecord(item);
      if (typeof row.lossIndex !== "number" || typeof row.text !== "string") {
        throw new RepairFlowError("answers 需要 lossIndex 和 text。");
      }
      return { lossIndex: row.lossIndex, text: row.text };
    });
    return draftAnswers(session, answers);
  }
  if (action === "confirm" || action === "reject") {
    const ids = proposalIds(session, body);
    return action === "confirm" ? confirmProposals(session, ids) : rejectProposals(session, ids);
  }
  if (action === "revise") {
    const proposalId = typeof body.id === "string" ? body.id : "";
    if (!proposalId) throw new RepairFlowError("请提供草案 id。");
    return reviseProposal(session, proposalId);
  }
  throw new HttpError(404, "未知修复动作。");
}

function proposalIds(session: RepairSession, body: JsonRecord): string[] {
  if (body.all === true) {
    const ids = pendingIds(session);
    if (ids.length === 0) throw new RepairFlowError("没有待确认的草案。");
    return ids;
  }
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
    throw new RepairFlowError("请提供 ids，或 all: true。");
  }
  return body.ids as string[];
}

async function listDirs(input: string): Promise<{
  path: string;
  parent: string;
  dirs: { name: string; path: string }[];
}> {
  const path = resolve(input);
  if (!(await isDirectory(path))) throw new UserInputError(`不是目录：${path}`);
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return { path, parent: dirname(path), dirs };
}

async function assertDirectory(project: string): Promise<void> {
  const path = resolve(project);
  if (!(await isDirectory(path))) throw new UserInputError(`不是目录：${path}`);
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new HttpError(400, "拒绝写出项目目录之外的路径。");
  }
}

function withLosses(bundle: AgentWorkBundle, losses: LossReportEntry[]): AgentWorkBundle {
  const copy = structuredClone(bundle);
  copy.manifest.loss_report = structuredClone(losses);
  return copy;
}

function summarize(bundle: AgentWorkBundle, losses: LossReportEntry[]) {
  return {
    source: bundle.manifest.source_agent,
    target: bundle.manifest.target_agent ?? null,
    rules: bundle.repo_context.rules.length,
    skills: bundle.repo_context.skills.length,
    mcp: bundle.repo_context.mcp_servers.length,
    transcript: bundle.transcript?.messages.length ?? 0,
    lossCount: losses.length,
  };
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserInputError("请求体必须是 JSON 对象。");
  }
  return value as JsonRecord;
}

function requireString(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new UserInputError(`缺少字段 ${key}。`);
  }
  return value.trim();
}

function optionalBundle(value: unknown): AgentWorkBundle | undefined {
  if (value === undefined || value === null) return undefined;
  const check = validateBundle(value);
  if (!check.ok) throw new UserInputError("Bundle failed validation:", check.errors);
  return check.bundle;
}

function stringList(body: JsonRecord, key: string): string[] {
  const value = body[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UserInputError(`${key} 必须是字符串数组。`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalStringList(body: JsonRecord, key: string): string[] | undefined {
  if (body[key] === undefined || body[key] === null) return undefined;
  return stringList(body, key);
}

function parseHint(value: unknown): LocateHint | undefined {
  if (value === undefined || value === null) return undefined;
  const row = asRecord(value);
  if (typeof row.name !== "string" || typeof row.sha256 !== "string") {
    throw new UserInputError("hint 需要 name 和 sha256。");
  }
  return { name: row.name, sha256: row.sha256 };
}

function transcriptTexts(body: JsonRecord): TranscriptText[] {
  const value = body.transcriptTexts;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new UserInputError("transcriptTexts 必须是数组。");
  return value.slice(0, 20).map((item, index) => {
    const row = asRecord(item);
    if (typeof row.text !== "string") throw new UserInputError("transcriptTexts 需要 text。");
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : `transcript-${index}.txt`;
    return { name, text: row.text };
  });
}

function optionalString(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new UserInputError(`${key} 必须是字符串。`);
  return value.trim();
}

function bool(body: JsonRecord, key: string): boolean {
  return body[key] === true;
}

function optionalInt(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new UserInputError(`${key} 必须是正整数。`);
  }
  return value;
}

async function readJson(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, "请求体超过 20MB。");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (err) {
    if (err instanceof UserInputError || err instanceof HttpError) throw err;
    throw new UserInputError("Invalid JSON");
  }
}

function mapError(err: unknown): { status: number; body: { error: string; details?: string[] } } {
  if (err instanceof UserInputError) {
    return { status: 400, body: { error: err.message, details: err.details } };
  }
  if (err instanceof RepairFlowError) {
    return { status: err.status, body: { error: err.message } };
  }
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message } };
  }
  if (err instanceof Error && err.message.startsWith("Unknown agent")) {
    return { status: 400, body: { error: err.message } };
  }
  console.error(err);
  return { status: 500, body: { error: "内部错误" } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

async function serveStatic(res: ServerResponse, staticDir: string | undefined, pathname: string): Promise<void> {
  if (!staticDir || !existsSync(staticDir)) {
    sendText(
      res,
      503,
      "Web UI 还没有构建。在仓库里运行 npm run web，或先运行 npm run build:web。",
    );
    return;
  }
  const root = resolve(staticDir);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const candidate = resolve(root, `.${requested}`);
  let filePath = candidate;
  if (!inside(root, filePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const found = existsSync(filePath) && (await stat(filePath)).isFile();
  if (!found) {
    if (requested === "/favicon.ico") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (extname(requested)) {
      sendText(res, 404, "Not found");
      return;
    }
    filePath = join(root, "index.html");
  }
  const body = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[extname(filePath)] ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-cache");
  res.end(body);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}
