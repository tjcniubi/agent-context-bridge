import { writeText } from "../utils/fs.js";
import { getAdapter } from "../adapters/index.js";
import { formatLossReport } from "../utils/loss-report.js";
import { UserInputError } from "../core/errors.js";
import { exportProject } from "../core/operations.js";

export interface ExportCliOptions {
  agent: string;
  project: string;
  out: string;
  includeUser?: boolean;
  session?: string;
}

export async function runExport(opts: ExportCliOptions): Promise<number> {
  try {
    const adapter = getAdapter(opts.agent);
    const { bundle, losses } = await exportProject({
      agent: opts.agent,
      project: opts.project,
      includeUser: opts.includeUser,
      sessionId: opts.session,
    });

    await writeText(opts.out, JSON.stringify(bundle, null, 2) + "\n");
    console.log(`Exported ${adapter.displayName} → ${opts.out}`);
    console.log(
      `  rules=${bundle.repo_context.rules.length} skills=${bundle.repo_context.skills.length} mcp=${bundle.repo_context.mcp_servers.length}`,
    );
    console.log("Loss report:");
    console.log(formatLossReport(losses));
    return 0;
  } catch (err) {
    return reportUserError(err);
  }
}

export function reportUserError(err: unknown): number {
  if (err instanceof UserInputError) {
    console.error(err.message);
    for (const detail of err.details) console.error(`  - ${detail}`);
    return 1;
  }
  throw err;
}
