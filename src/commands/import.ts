import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { getAdapter } from "../adapters/index.js";
import { validateBundle } from "../protocol/validate.js";
import { formatLossReport } from "../utils/loss-report.js";
import type { AgentWorkBundle } from "../protocol/types.js";

export interface ImportCliOptions {
  agent: string;
  project: string;
  file: string;
  dryRun?: boolean;
}

export async function runImport(opts: ImportCliOptions): Promise<number> {
  const adapter = getAdapter(opts.agent);
  const raw = await readFile(opts.file, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON: ${(err as Error).message}`);
    return 1;
  }
  const check = validateBundle(data);
  if (!check.ok) {
    console.error("Bundle failed validation:");
    for (const e of check.errors) console.error(`  - ${e}`);
    return 1;
  }
  const bundle = check.bundle as AgentWorkBundle;
  bundle.manifest.target_agent = adapter.id;

  const { written, losses } = await adapter.importRepoContext(bundle, {
    projectRoot: resolve(opts.project),
    dryRun: opts.dryRun,
  });

  console.log(
    `${opts.dryRun ? "[dry-run] " : ""}Imported → ${adapter.displayName} (${written.length} paths)`,
  );
  for (const w of written) console.log(`  + ${w}`);
  console.log("Loss report:");
  console.log(formatLossReport(losses));
  return 0;
}
