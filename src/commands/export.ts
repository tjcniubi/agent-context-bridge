import { resolve } from "node:path";
import { writeText } from "../utils/fs.js";
import { getAdapter } from "../adapters/index.js";
import { formatLossReport } from "../utils/loss-report.js";
import { validateBundle } from "../protocol/validate.js";

export interface ExportCliOptions {
  agent: string;
  project: string;
  out: string;
  includeUser?: boolean;
  session?: string;
}

export async function runExport(opts: ExportCliOptions): Promise<number> {
  const adapter = getAdapter(opts.agent);
  const projectRoot = resolve(opts.project);
  const { bundle, losses } = await adapter.exportRepoContext({
    projectRoot,
    includeUser: opts.includeUser,
    sessionId: opts.session,
  });

  const check = validateBundle(bundle);
  if (!check.ok) {
    console.error("Exported bundle failed self-validation:");
    for (const e of check.errors) console.error(`  - ${e}`);
    return 1;
  }

  await writeText(opts.out, JSON.stringify(bundle, null, 2) + "\n");
  console.log(`Exported ${adapter.displayName} → ${opts.out}`);
  console.log(
    `  rules=${bundle.repo_context.rules.length} skills=${bundle.repo_context.skills.length} mcp=${bundle.repo_context.mcp_servers.length}`,
  );
  console.log("Loss report:");
  console.log(formatLossReport(losses));
  return 0;
}
