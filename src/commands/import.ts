import { getAdapter } from "../adapters/index.js";
import { formatLossReport } from "../utils/loss-report.js";
import { importProject, readBundleFile } from "../core/operations.js";
import { reportUserError } from "./export.js";

export interface ImportCliOptions {
  agent: string;
  project: string;
  file: string;
  dryRun?: boolean;
  includeUser?: boolean;
  applyTranscript?: boolean;
}

export async function runImport(opts: ImportCliOptions): Promise<number> {
  try {
    const adapter = getAdapter(opts.agent);
    const data = await readBundleFile(opts.file);
    const { written, losses, changes } = await importProject({
      agent: opts.agent,
      project: opts.project,
      bundle: data,
      dryRun: opts.dryRun,
      includeUser: opts.includeUser,
      applyTranscript: opts.applyTranscript,
    });

    console.log(
      `${opts.dryRun ? "[dry-run] " : ""}Imported → ${adapter.displayName} (${written.length} paths)`,
    );
    const rows = changes.length > 0 ? changes : written.map((path) => ({ path, action: "create" as const }));
    for (const row of rows) console.log(`  ${row.action} ${row.path}`);
    console.log("Loss report:");
    console.log(formatLossReport(losses));
    return 0;
  } catch (err) {
    return reportUserError(err);
  }
}
