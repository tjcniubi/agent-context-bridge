#!/usr/bin/env node
import { Command } from "commander";
import { runValidate } from "./commands/validate.js";
import { runExport } from "./commands/export.js";
import { runImport } from "./commands/import.js";
import { runConvert } from "./commands/convert.js";
import { runWeb } from "./commands/web.js";
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
  .option("--include-user", "Also attempt user-global configs", false)
  .option("--session <id>", "Optional session id for Layer 3 transcript (stub)")
  .action(async (opts) => {
    process.exitCode = await runExport({
      agent: opts.agent,
      project: opts.project,
      out: opts.out,
      includeUser: opts.includeUser,
      session: opts.session,
    });
  });

program
  .command("import")
  .description("Import an Agent Work Bundle into an agent project layout")
  .requiredOption("-a, --agent <id>", "Target agent id (cursor|trae)")
  .option("-p, --project <dir>", "Project root", ".")
  .requiredOption("-f, --file <file>", "Input bundle path")
  .option("--dry-run", "Do not write files", false)
  .action(async (opts) => {
    process.exitCode = await runImport({
      agent: opts.agent,
      project: opts.project,
      file: opts.file,
      dryRun: opts.dryRun,
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
  .option("--include-user", "Include user-global on export", false)
  .action(async (opts) => {
    process.exitCode = await runConvert({
      from: opts.from,
      to: opts.to,
      project: opts.project,
      outBundle: opts.outBundle,
      dryRun: opts.dryRun,
      includeUser: opts.includeUser,
    });
  });

program
  .command("web")
  .description("Start the local web UI (export, import, convert, guided repair)")
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
