/**
 * Export / import / convert without console I/O.
 * CLI commands print these results; the local web API returns them as JSON.
 */
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAdapter } from "../adapters/index.js";
import { TranscriptSchema } from "../protocol/schema.js";
import { validateBundle } from "../protocol/validate.js";
import type { AgentWorkBundle, LossReportEntry, Transcript } from "../protocol/types.js";
import { TRANSCRIPT_SIDECAR } from "../transcript/limits.js";
import { previewTranscriptText, renderTranscriptMarkdown } from "../transcript/render.js";
import { writeText } from "../utils/fs.js";
import { resolveInside } from "../utils/path-safety.js";
import { UserInputError } from "./errors.js";
import type { FileChange } from "../adapters/types.js";

export interface ExportRequest {
  agent: string;
  project: string;
  includeUser?: boolean;
  sessionId?: string;
  includeTranscript?: boolean;
  transcriptMaxBytes?: number;
  transcriptMaxMessages?: number;
  /** Library/tests only. The HTTP API does not accept this. */
  userHome?: string;
  allowExternalTranscriptFile?: boolean;
}

export interface ExportResult {
  bundle: AgentWorkBundle;
  losses: LossReportEntry[];
}

export async function exportProject(opts: ExportRequest): Promise<ExportResult> {
  const adapter = getAdapter(opts.agent);
  const projectRoot = resolve(opts.project);
  const { bundle, losses } = await adapter.exportRepoContext({
    projectRoot,
    includeUser: opts.includeUser,
    sessionId: opts.sessionId,
    includeTranscript: opts.includeTranscript,
    transcriptMaxBytes: opts.transcriptMaxBytes,
    transcriptMaxMessages: opts.transcriptMaxMessages,
    userHome: opts.userHome,
    allowExternalTranscriptFile: opts.allowExternalTranscriptFile,
  });

  const check = validateBundle(bundle);
  if (!check.ok) {
    throw new UserInputError(
      "Exported bundle failed self-validation:",
      check.errors,
    );
  }

  return { bundle, losses };
}

export interface ImportRequest {
  agent: string;
  project: string;
  bundle: unknown;
  dryRun?: boolean;
  includeUser?: boolean;
  applyTranscript?: boolean;
  /** Library/tests only. The HTTP API does not accept this. */
  userHome?: string;
}

export interface ImportResult {
  bundle: AgentWorkBundle;
  written: string[];
  losses: LossReportEntry[];
  changes: FileChange[];
}

export async function importProject(opts: ImportRequest): Promise<ImportResult> {
  const adapter = getAdapter(opts.agent);
  const check = validateBundle(opts.bundle);
  if (!check.ok) {
    throw new UserInputError("Bundle failed validation:", check.errors);
  }
  const bundle = check.bundle as AgentWorkBundle;
  bundle.manifest.target_agent = adapter.id;

  const { written, losses, changes } = await adapter.importRepoContext(bundle, {
    projectRoot: resolve(opts.project),
    dryRun: opts.dryRun,
    includeUser: opts.includeUser,
    applyTranscript: opts.applyTranscript,
    userHome: opts.userHome,
  });

  return { bundle, written, losses, changes };
}

export async function readBundleFile(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new UserInputError(
      `Failed to read ${file}: ${(err as Error).message}`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new UserInputError(`Invalid JSON: ${(err as Error).message}`);
  }
}

export interface ConvertRequest {
  from: string;
  to: string;
  project: string;
  outBundle?: string;
  dryRun?: boolean;
  includeUser?: boolean;
  includeTranscript?: boolean;
  sessionId?: string;
  transcriptMaxBytes?: number;
  transcriptMaxMessages?: number;
  applyTranscript?: boolean;
  /** Write the intermediate bundle. CLI passes true. Web can skip the temp file. */
  persistBundle?: boolean;
  userHome?: string;
  allowExternalTranscriptFile?: boolean;
}

export interface ConvertResult {
  bundle: AgentWorkBundle;
  bundlePath?: string;
  written: string[];
  changes: FileChange[];
  exportLosses: LossReportEntry[];
  importLosses: LossReportEntry[];
}

export async function convertProject(opts: ConvertRequest): Promise<ConvertResult> {
  getAdapter(opts.from);
  getAdapter(opts.to);

  const exported = await exportProject({
    agent: opts.from,
    project: opts.project,
    includeUser: opts.includeUser,
    includeTranscript: opts.includeTranscript,
    sessionId: opts.sessionId,
    transcriptMaxBytes: opts.transcriptMaxBytes,
    transcriptMaxMessages: opts.transcriptMaxMessages,
    userHome: opts.userHome,
    allowExternalTranscriptFile: opts.allowExternalTranscriptFile,
  });

  let bundlePath: string | undefined;
  if (opts.outBundle || opts.persistBundle) {
    bundlePath =
      opts.outBundle ??
      join(tmpdir(), `acb-${opts.from}-to-${opts.to}-${Date.now()}.bundle.json`);
    if (opts.outBundle) {
      await mkdir(resolve(opts.outBundle, ".."), { recursive: true });
    }
    await writeText(bundlePath, JSON.stringify(exported.bundle, null, 2) + "\n");
  }

  const imported = await importProject({
    agent: opts.to,
    project: opts.project,
    bundle: structuredClone(exported.bundle),
    dryRun: opts.dryRun,
    includeUser: opts.includeUser,
    applyTranscript: opts.applyTranscript,
    userHome: opts.userHome,
  });

  return {
    bundle: imported.bundle,
    bundlePath,
    written: imported.written,
    changes: imported.changes,
    exportLosses: exported.losses,
    importLosses: imported.losses,
  };
}

export function coerceTranscript(data: unknown): Transcript {
  if (data && typeof data === "object" && "messages" in data && !("manifest" in data)) {
    const parsed = TranscriptSchema.safeParse(data);
    if (!parsed.success) {
      throw new UserInputError(
        "Transcript JSON failed validation:",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      );
    }
    return parsed.data as Transcript;
  }
  const check = validateBundle(data);
  if (!check.ok || !check.bundle) {
    throw new UserInputError("Bundle failed validation:", check.errors);
  }
  if (!check.bundle.transcript) {
    throw new UserInputError("Bundle 里没有 transcript。");
  }
  return check.bundle.transcript;
}

export interface TranscriptApplyResult {
  written: string[];
  changes: FileChange[];
  losses: LossReportEntry[];
  preview: string;
  transcript: Transcript;
}

/** Write `.acb/TRANSCRIPT.md` only. Does not touch chat UI or encrypted stores. */
export async function applyTranscriptFile(opts: {
  project: string;
  bundle: unknown;
  dryRun?: boolean;
}): Promise<TranscriptApplyResult> {
  const transcript = coerceTranscript(opts.bundle);
  const projectRoot = resolve(opts.project);
  const abs = await resolveInside(projectRoot, TRANSCRIPT_SIDECAR);
  if (!abs) {
    throw new UserInputError("拒绝把 transcript 写到项目目录之外。");
  }
  const content = renderTranscriptMarkdown(transcript);
  let existing: string | undefined;
  try {
    existing = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const action: FileChange["action"] =
    existing === undefined ? "create" : existing === content ? "unchanged" : "update";
  if (!opts.dryRun && action !== "unchanged") await writeText(abs, content);
  const losses = [
    {
      code: "transcript.sidecar",
      message: opts.dryRun
        ? "Dry-run: would write .acb/TRANSCRIPT.md. Chat UI was not modified."
        : "Wrote a lossy transcript sidecar. Chat UI was not modified.",
      severity: "info" as const,
      path: TRANSCRIPT_SIDECAR,
    },
    {
      code: "transcript.ui_not_injected",
      message: "Refused to inject the transcript into the agent chat store or any encrypted database.",
      severity: "info" as const,
    },
  ];
  return {
    written: [TRANSCRIPT_SIDECAR],
    changes: [{ path: TRANSCRIPT_SIDECAR, action }],
    losses,
    preview: previewTranscriptText(transcript),
    transcript,
  };
}
