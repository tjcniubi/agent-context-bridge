import { writeText } from "../utils/fs.js";
import { formatLossReport } from "../utils/loss-report.js";
import { getAdapter } from "../adapters/index.js";
import { applyTranscriptFile, coerceTranscript, exportProject, readBundleFile } from "../core/operations.js";
import { previewTranscriptText } from "../transcript/render.js";
import { reportUserError } from "./export.js";

export interface TranscriptExportCliOptions {
  agent: string;
  project: string;
  out: string;
  session?: string;
  transcriptMaxBytes?: number;
  transcriptMaxMessages?: number;
  includeUser?: boolean;
}

export async function runTranscriptExport(opts: TranscriptExportCliOptions): Promise<number> {
  try {
    const adapter = getAdapter(opts.agent);
    const { bundle, losses } = await exportProject({
      agent: opts.agent,
      project: opts.project,
      includeUser: opts.includeUser,
      includeTranscript: true,
      sessionId: opts.session,
      transcriptMaxBytes: opts.transcriptMaxBytes,
      transcriptMaxMessages: opts.transcriptMaxMessages,
      allowExternalTranscriptFile: true,
    });
    await writeText(opts.out, JSON.stringify(bundle, null, 2) + "\n");
    const count = bundle.transcript?.messages.length ?? 0;
    console.log(`Transcript export ${adapter.displayName} → ${opts.out}`);
    console.log(`  messages=${count}${bundle.transcript?.source_session_id ? ` session=${bundle.transcript.source_session_id}` : ""}`);
    if (bundle.transcript) console.log(previewTranscriptText(bundle.transcript, 6));
    console.log("Loss report:");
    console.log(formatLossReport(losses));
    return 0;
  } catch (err) {
    return reportUserError(err);
  }
}

export interface TranscriptImportCliOptions {
  project: string;
  file: string;
  apply?: boolean;
  dryRun?: boolean;
}

export async function runTranscriptImport(opts: TranscriptImportCliOptions): Promise<number> {
  try {
    const data = await readBundleFile(opts.file);
    const transcript = coerceTranscript(data);
    console.log(previewTranscriptText(transcript, 12));
    if (!opts.apply) {
      console.log("");
      console.log("Preview only. Re-run with --apply to write .acb/TRANSCRIPT.md.");
      console.log("The chat UI and any encrypted local database are never modified.");
      return 0;
    }
    const result = await applyTranscriptFile({
      project: opts.project,
      bundle: data,
      dryRun: opts.dryRun,
    });
    console.log(`${opts.dryRun ? "[dry-run] " : ""}Transcript sidecar`);
    for (const change of result.changes) console.log(`  ${change.action} ${change.path}`);
    console.log("Loss report:");
    console.log(formatLossReport(result.losses));
    return 0;
  } catch (err) {
    return reportUserError(err);
  }
}
