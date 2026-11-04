/**
 * Export / import / convert without console I/O.
 * CLI commands print these results; the local web API returns them as JSON.
 */
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAdapter } from "../adapters/index.js";
import { validateBundle } from "../protocol/validate.js";
import type { AgentWorkBundle, LossReportEntry } from "../protocol/types.js";
import { writeText } from "../utils/fs.js";
import { UserInputError } from "./errors.js";

export interface ExportRequest {
  agent: string;
  project: string;
  includeUser?: boolean;
  sessionId?: string;
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
}

export interface ImportResult {
  bundle: AgentWorkBundle;
  written: string[];
  losses: LossReportEntry[];
}

export async function importProject(opts: ImportRequest): Promise<ImportResult> {
  const adapter = getAdapter(opts.agent);
  const check = validateBundle(opts.bundle);
  if (!check.ok) {
    throw new UserInputError("Bundle failed validation:", check.errors);
  }
  const bundle = check.bundle as AgentWorkBundle;
  bundle.manifest.target_agent = adapter.id;

  const { written, losses } = await adapter.importRepoContext(bundle, {
    projectRoot: resolve(opts.project),
    dryRun: opts.dryRun,
  });

  return { bundle, written, losses };
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
  /** Write the intermediate bundle. CLI passes true. Web can skip the temp file. */
  persistBundle?: boolean;
}

export interface ConvertResult {
  bundle: AgentWorkBundle;
  bundlePath?: string;
  written: string[];
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
  });

  return {
    bundle: imported.bundle,
    bundlePath,
    written: imported.written,
    exportLosses: exported.losses,
    importLosses: imported.losses,
  };
}
