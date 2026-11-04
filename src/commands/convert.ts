import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getAdapter } from "../adapters/index.js";
import { runExport } from "./export.js";
import { runImport } from "./import.js";
import { tmpdir } from "node:os";

export interface ConvertCliOptions {
  from: string;
  to: string;
  project: string;
  outBundle?: string;
  dryRun?: boolean;
  includeUser?: boolean;
  includeTranscript?: boolean;
  session?: string;
  transcriptMaxBytes?: number;
  transcriptMaxMessages?: number;
  applyTranscript?: boolean;
}

/**
 * convert = export(from) then import(to), optionally keeping the intermediate bundle.
 */
export async function runConvert(opts: ConvertCliOptions): Promise<number> {
  getAdapter(opts.from);
  getAdapter(opts.to);

  const bundlePath =
    opts.outBundle ??
    join(tmpdir(), `acb-${opts.from}-to-${opts.to}-${Date.now()}.bundle.json`);

  if (opts.outBundle) {
    await mkdir(resolve(opts.outBundle, ".."), { recursive: true });
  }

  const exportCode = await runExport({
    agent: opts.from,
    project: opts.project,
    out: bundlePath,
    includeUser: opts.includeUser,
    includeTranscript: opts.includeTranscript,
    session: opts.session,
    transcriptMaxBytes: opts.transcriptMaxBytes,
    transcriptMaxMessages: opts.transcriptMaxMessages,
  });
  if (exportCode !== 0) return exportCode;

  const importCode = await runImport({
    agent: opts.to,
    project: opts.project,
    file: bundlePath,
    dryRun: opts.dryRun,
    includeUser: opts.includeUser,
    applyTranscript: opts.applyTranscript,
  });
  if (importCode !== 0) return importCode;

  console.log(`Convert ${opts.from} → ${opts.to} complete.`);
  console.log(`  bundle: ${bundlePath}`);
  return 0;
}
