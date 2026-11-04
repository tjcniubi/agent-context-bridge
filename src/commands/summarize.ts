import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { UserInputError } from "../core/errors.js";
import type { AgentWorkBundle, WorkState } from "../protocol/types.js";
import { hasWorkStateContent, renderWorkStateMarkdown } from "../protocol/work-state-markdown.js";
import { validateBundle } from "../protocol/validate.js";
import {
  applyWorkState,
  mergeSummary,
  parseAgent,
  summarizeSessions,
  summaryLossesFor,
} from "../summarize/run.js";
import { exists, writeText } from "../utils/fs.js";
import { formatLossReport } from "../utils/loss-report.js";
import { reportUserError } from "./export.js";

export interface SummarizeCliOptions {
  project?: string;
  agent?: string;
  out?: string;
  stdout?: boolean;
  dryRun?: boolean;
  session?: string;
  transcript?: string[];
  notes?: string;
  cursorHome?: string;
  home?: string;
  maxSessions?: string;
  writeSidecar?: boolean;
  model?: boolean;
  modelName?: string;
  modelBaseUrl?: string;
  modelConfig?: string;
}

export async function runSummarize(opts: SummarizeCliOptions): Promise<number> {
  try {
    const agent = parseAgent(opts.agent ?? "both");
    const maxSessions = opts.maxSessions === undefined ? 1 : Number(opts.maxSessions);
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new UserInputError("--max-sessions 必须是正整数。");
    }
    const projectRoot = resolve(opts.project ?? ".");
    if (!opts.model && (opts.modelName || opts.modelBaseUrl || opts.modelConfig)) {
      console.error("--model-name、--model-base-url、--model-config 只有在加上 --model 时才会使用。");
    }
    const result = await summarizeSessions({
      projectRoot,
      agent,
      sessionId: opts.session,
      transcriptPaths: opts.transcript,
      notesPath: opts.notes,
      cursorHome: opts.cursorHome,
      homeDir: opts.home,
      maxSessions,
      ...(opts.model
        ? {
            model: {
              enabled: true,
              ...(opts.modelName ? { model: opts.modelName } : {}),
              ...(opts.modelBaseUrl ? { baseUrl: opts.modelBaseUrl } : {}),
              ...(opts.modelConfig ? { configPath: opts.modelConfig } : {}),
            },
          }
        : {}),
    });
    const existing = opts.out ? await readBundleIfPresent(opts.out) : undefined;
    const losses = summaryLossesFor(existing?.work_state, result);
    const workState = mergeSummary(existing?.work_state, result);
    const writing = Boolean(opts.out) && !opts.dryRun;
    const bundle = applyWorkState({
      existing,
      workState,
      summaryLosses: losses,
      projectRoot,
      sourceAgent: existing?.manifest.source_agent ?? result.sourceAgent,
      written: writing,
    });
    const check = validateBundle(bundle);
    if (!check.ok) throw new UserInputError("Summarized bundle failed validation:", check.errors);
    const valid = check.bundle as AgentWorkBundle;

    if (writing && opts.out) {
      await writeText(resolve(opts.out), JSON.stringify(valid, null, 2) + "\n");
    }
    if (opts.writeSidecar && !opts.dryRun && hasWorkStateContent(valid)) {
      const sidecar = resolve(projectRoot, ".acb/WORK_STATE.md");
      await writeText(sidecar, renderWorkStateMarkdown(valid));
      const line = `Wrote ${sidecar}`;
      if (opts.stdout) console.error(line);
      else console.log(line);
    }

    if (opts.stdout) {
      process.stdout.write(JSON.stringify(valid, null, 2) + "\n");
      console.error(formatLossReport(valid.manifest.loss_report));
      return 0;
    }
    console.log(writing && opts.out ? `Wrote ${resolve(opts.out)}` : "Work State preview (not written)");
    console.log(formatWorkState(workState));
    console.log("Loss report:");
    console.log(formatLossReport(losses));
    return 0;
  } catch (err) {
    return reportUserError(err);
  }
}

async function readBundleIfPresent(file: string): Promise<AgentWorkBundle | undefined> {
  const full = resolve(file);
  if (!(await exists(full))) return undefined;
  let raw: string;
  try {
    raw = await readFile(full, "utf8");
  } catch (err) {
    throw new UserInputError(`Failed to read ${full}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new UserInputError(`Invalid JSON in ${full}: ${(err as Error).message}`);
  }
  const check = validateBundle(data);
  if (!check.ok) throw new UserInputError(`Existing bundle failed validation (${full}):`, check.errors);
  return check.bundle;
}

function formatWorkState(ws: WorkState): string {
  const lines: string[] = [];
  lines.push(`goal: ${ws.goal ?? ""}`);
  lines.push("decisions:");
  for (const decision of ws.decisions) {
    lines.push(`  - ${decision.summary}${decision.rationale ? ` — ${decision.rationale}` : ""}`);
  }
  lines.push("open_loops:");
  for (const loop of ws.open_loops) {
    lines.push(`  - ${loop.summary}${loop.priority ? ` (${loop.priority})` : ""}`);
  }
  lines.push("file_anchors:");
  for (const anchor of ws.file_anchors) lines.push(`  - ${anchor.path}${anchor.note ? `: ${anchor.note}` : ""}`);
  lines.push("constraints:");
  for (const constraint of ws.constraints) lines.push(`  - ${constraint}`);
  lines.push("known_pitfalls:");
  for (const pitfall of ws.known_pitfalls) lines.push(`  - ${pitfall}`);
  if (ws.last_summary) lines.push("last_summary:", ws.last_summary);
  return lines.join("\n");
}
