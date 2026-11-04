import { getAdapter } from "../adapters/index.js";
import { formatLossReport } from "../utils/loss-report.js";
import { importProject, readBundleFile } from "../core/operations.js";
import { reportUserError } from "./export.js";

export interface ImportCliOptions {
  agent: string;
  project: string;
  file: string;
  dryRun?: boolean;
}

export async function runImport(opts: ImportCliOptions): Promise<number> {
  try {
    const adapter = getAdapter(opts.agent);
    const data = await readBundleFile(opts.file);
    const { written, losses } = await importProject({
      agent: opts.agent,
      project: opts.project,
      bundle: data,
      dryRun: opts.dryRun,
    });

    console.log(
      `${opts.dryRun ? "[dry-run] " : ""}Imported → ${adapter.displayName} (${written.length} paths)`,
    );
    for (const w of written) console.log(`  + ${w}`);
    console.log("Loss report:");
    console.log(formatLossReport(losses));
    return 0;
  } catch (err) {
    return reportUserError(err);
  }
}
