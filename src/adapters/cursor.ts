/**
 * Cursor adapter.
 *
 * Project paths (including nested AGENTS.md and nested `.cursor/rules`):
 *   AGENTS.md
 *   .cursor/rules/**\/*.mdc
 *   .cursor/skills/<name>/SKILL.md
 *   .cursor/mcp.json
 *   .agents/skills/ and the Trae layout, so a bundle can be mapped either way
 *
 * User scope (`--include-user`):
 *   ~/.cursor/mcp.json   (env and headers redacted)
 *   ~/.cursor/skills/
 *   ~/.cursor/rules/
 * Account-synced User Rules have no file and are reported as a loss.
 *
 * Transcripts (`--include-transcript` / `--session`):
 *   ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
 *   Plaintext exports. Database files are never opened.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentAdapter } from "./types.js";
import { cursorLayout, exportAgent, importAgent } from "./transfer.js";

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  paths: {
    project: {
      agentsMd: "AGENTS.md",
      rulesDir: cursorLayout.rulesDir,
      skillsDir: cursorLayout.skillsDir,
      mcpJson: cursorLayout.mcpJson,
      instructionNames: ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"],
    },
    user: {
      mcpJson: join(homedir(), ".cursor", "mcp.json"),
      skillsDir: join(homedir(), ".cursor", "skills"),
      rulesDir: join(homedir(), ".cursor", "rules"),
    },
  },

  exportRepoContext(opts) {
    return exportAgent(cursorLayout, opts);
  },

  importRepoContext(bundle, opts) {
    return importAgent(cursorLayout, bundle, opts);
  },
};
