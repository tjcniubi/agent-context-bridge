#!/usr/bin/env node
import { Command } from "commander";
import { runValidate } from "./commands/validate.js";
import { reportUserError, runExport } from "./commands/export.js";
import { runImport } from "./commands/import.js";
import { runConvert } from "./commands/convert.js";
import { runTranscriptExport, runTranscriptImport } from "./commands/transcript.js";
import { transcriptLimits } from "./commands/flags.js";
import { runWeb } from "./commands/web.js";
import { runSummarize } from "./commands/summarize.js";
import { listAdapters } from "./adapters/index.js";

const program = new Command();

program
  .name("acb")
  .description(
    "Agent Context Bridge — migrate durable context & work state across AI coding agents",
  )
  .version("0.1.0");

program
  .command("validate")
  .description("Validate an Agent Work Bundle JSON against the v0.1 schema")
  .argument("<file>", "Path to *.bundle.json")
  .action(async (file: string) => {
    process.exitCode = await runValidate(file);
  });

program
  .command("export")
  .description("Export repo context from an agent into an Agent Work Bundle")
  .requiredOption("-a, --agent <id>", "Source agent id (cursor|trae)")
  .option("-p, --project <dir>", "Project root", ".")
  .requiredOption("-o, --out <file>", "Output bundle path")
  .option("--include-user", "Also read user-global configs (user MCP env is redacted)", false)
  .option("--include-transcript", "Read a lossy transcript when one is safely available", false)
  .option("--with-transcript", "Alias of --include-transcript", false)
  .option("--session <id>", "Session id or path to a plaintext transcript export")
  .option("--transcript-max-bytes <n>", "Cap transcript payload bytes (default 1500000)")
  .option("--transcript-max-messages <n>", "Cap transcript messages (default 400)")
  .action(async (opts) => {
    try {
      const limits = transcriptLimits(opts);
      process.exitCode = await runExport({
        agent: opts.agent,
        project: opts.project,
        out: opts.out,
        includeUser: opts.includeUser,
        session: opts.session,
        includeTranscript: Boolean(opts.includeTranscript || opts.withTranscript),
        transcriptMaxBytes: limits.transcriptMaxBytes,
        transcriptMaxMessages: limits.transcriptMaxMessages,
      });
    } catch (err) {
      process.exitCode = reportUserError(err);
    }
  });

program
  .command("import")
  .description("Import an Agent Work Bundle into an agent project layout")
  .requiredOption("-a, --agent <id>", "Target agent id (cursor|trae)")
  .option("-p, --project <dir>", "Project root", ".")
  .requiredOption("-f, --file <file>", "Input bundle path")
  .option("--dry-run", "Do not write files; print create/update/unchanged", false)
  .option("--include-user", "Also write user-scoped entries under the home directory", false)
  .option("--apply-transcript", "Write .acb/TRANSCRIPT.md (does not inject a chat UI)", false)
  .action(async (opts) => {
    process.exitCode = await runImport({
      agent: opts.agent,
      project: opts.project,
      file: opts.file,
      dryRun: opts.dryRun,
      includeUser: opts.includeUser,
      applyTranscript: opts.applyTranscript,
    });
  });

program
  .command("convert")
  .description("Export from one agent and import into another (same project)")
  .requiredOption("--from <id>", "Source agent")
  .requiredOption("--to <id>", "Target agent")
  .option("-p, --project <dir>", "Project root", ".")
  .option("-o, --out-bundle <file>", "Keep intermediate bundle at this path")
  .option("--dry-run", "Export for real, import as dry-run", false)
  .option("--include-user", "Read and write user-global configs (user MCP env is redacted)", false)
  .option("--include-transcript", "Carry a lossy transcript inside the bundle", false)
  .option("--with-transcript", "Alias of --include-transcript", false)
  .option("--session <id>", "Session id or plaintext transcript path")
  .option("--transcript-max-bytes <n>", "Cap transcript payload bytes (default 1500000)")
  .option("--transcript-max-messages <n>", "Cap transcript messages (default 400)")
  .option("--apply-transcript", "Also write .acb/TRANSCRIPT.md on import", false)
  .action(async (opts) => {
    try {
      const limits = transcriptLimits(opts);
      process.exitCode = await runConvert({
        from: opts.from,
        to: opts.to,
        project: opts.project,
        outBundle: opts.outBundle,
        dryRun: opts.dryRun,
        includeUser: opts.includeUser,
        includeTranscript: Boolean(opts.includeTranscript || opts.withTranscript),
        session: opts.session,
        transcriptMaxBytes: limits.transcriptMaxBytes,
        transcriptMaxMessages: limits.transcriptMaxMessages,
        applyTranscript: opts.applyTranscript,
      });
    } catch (err) {
      process.exitCode = reportUserError(err);
    }
  });

const transcript = program.command("transcript").description("Export or apply a lossy transcript");

transcript
  .command("export")
  .description("Export repo context plus a lossy transcript into a bundle")
  .requiredOption("-a, --agent <id>", "Source agent id (cursor|trae)")
  .option("-p, --project <dir>", "Project root", ".")
  .requiredOption("-o, --out <file>", "Output bundle path")
  .option("--include-user", "Also read user-global configs (user MCP env is redacted)", false)
  .option("--session <id>", "Session id or path to a plaintext export")
  .option("--transcript-max-bytes <n>", "Cap transcript payload bytes (default 1500000)")
  .option("--transcript-max-messages <n>", "Cap transcript messages (default 400)")
  .action(async (opts) => {
    try {
      const limits = transcriptLimits(opts);
      process.exitCode = await runTranscriptExport({
        agent: opts.agent,
        project: opts.project,
        out: opts.out,
        includeUser: opts.includeUser,
        session: opts.session,
        transcriptMaxBytes: limits.transcriptMaxBytes,
        transcriptMaxMessages: limits.transcriptMaxMessages,
      });
    } catch (err) {
      process.exitCode = reportUserError(err);
    }
  });

transcript
  .command("import")
  .description("Preview a transcript and, with --apply, write .acb/TRANSCRIPT.md")
  .option("-p, --project <dir>", "Project root", ".")
  .requiredOption("-f, --file <file>", "Bundle or transcript JSON")
  .option("--apply", "Write .acb/TRANSCRIPT.md after printing the preview", false)
  .option("--dry-run", "With --apply, show the sidecar path without writing", false)
  .action(async (opts) => {
    process.exitCode = await runTranscriptImport({
      project: opts.project,
      file: opts.file,
      apply: opts.apply,
      dryRun: opts.dryRun,
    });
  });

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program
  .command("summarize")
  .description("Fill Work State from a Cursor session, notes, or a plaintext export (lossy)")
  .option("-p, --project <dir>", "Project root", ".")
  .option("-a, --agent <id>", "cursor, trae, or both", "both")
  .option("-o, --out <file>", "Bundle path to create or update")
  .option("--stdout", "Print the bundle JSON to stdout", false)
  .option("--dry-run", "Print Work State and losses without writing", false)
  .option("--session <id>", "Cursor session id")
  .option("--transcript <path>", "Plaintext transcript (json, jsonl, or text). Repeatable.", collect, [] as string[])
  .option("--notes <path>", "Notes file. Markdown headings win over heuristics.")
  .option("--cursor-home <dir>", "Override ~/.cursor")
  .option("--home <dir>", "Override the home directory used to detect a Trae chat database")
  .option("--max-sessions <n>", "How many recent Cursor sessions to read", "1")
  .option("--write-sidecar", "Also write <project>/.acb/WORK_STATE.md", false)
  .option("--model", "Draft Work State with an OpenAI-compatible model; fall back to rules on failure", false)
  .option("--model-name <id>", "Model id. Overrides ACB_MODEL and the config file. Requires --model")
  .option("--model-base-url <url>", "API base URL. Overrides ACB_MODEL_BASE_URL. Requires --model")
  .option("--model-config <path>", "JSON config (model, baseUrl, optional apiKey). Requires --model. The key is not a flag")
  .action(async (opts) => {
    process.exitCode = await runSummarize({
      project: opts.project,
      agent: opts.agent,
      out: opts.out,
      stdout: opts.stdout,
      dryRun: opts.dryRun,
      session: opts.session,
      transcript: opts.transcript,
      notes: opts.notes,
      cursorHome: opts.cursorHome,
      home: opts.home,
      maxSessions: opts.maxSessions,
      writeSidecar: opts.writeSidecar,
      model: opts.model,
      modelName: opts.modelName,
      modelBaseUrl: opts.modelBaseUrl,
      modelConfig: opts.modelConfig,
    });
  });

program
  .command("web")
  .description("Start the local web UI (export, import, convert, summarize, guided repair)")
  .option("-p, --port <n>", "Port", "4173")
  .option("--host <host>", "Bind address (default 127.0.0.1)", "127.0.0.1")
  .option("--dev", "Serve the Vite dev middleware instead of web/dist", false)
  .action(async (opts) => {
    process.exitCode = await runWeb({
      port: opts.port,
      host: opts.host,
      dev: opts.dev,
    });
  });

program
  .command("adapters")
  .description("List supported agent adapters")
  .action(() => {
    for (const a of listAdapters()) {
      console.log(`${a.id}\t${a.displayName}`);
      console.log(`  rules:  ${a.paths.project.rulesDir}`);
      console.log(`  skills: ${a.paths.project.skillsDir}`);
      console.log(`  mcp:    ${a.paths.project.mcpJson}`);
    }
  });

program.parseAsync(process.argv);
