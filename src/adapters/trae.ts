/**
 * Trae adapter.
 *
 * Project paths (root and nested module rules):
 *   AGENTS.md (needs Settings → Include AGENTS.md in the context)
 *   .trae/rules/**\/*.md
 *   <module>/.trae/rules/**\/*.md
 *   .trae/skills/<name>/SKILL.md
 *   .trae/mcp.json (needs Enable Project MCP)
 *   .agents/skills/ and the Cursor layout, so a bundle can be mapped either way
 *
 * User scope (`--include-user`):
 *   ~/.trae/user_rules   (file or directory)
 *   ~/.trae/skills/
 * User MCP has no documented file and is reported as a loss.
 *
 * Transcripts:
 *   Plaintext Export Chat / notes under .acb/imports or .trae/exports.
 *   The encrypted ModularData database is never opened.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentAdapter } from "./types.js";
import { exportAgent, importAgent, traeLayout } from "./transfer.js";

export const traeAdapter: AgentAdapter = {
  id: "trae",
  displayName: "Trae",
  paths: {
    project: {
      agentsMd: "AGENTS.md",
      rulesDir: traeLayout.rulesDir,
      skillsDir: traeLayout.skillsDir,
      mcpJson: traeLayout.mcpJson,
      instructionNames: ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"],
    },
    user: {
      skillsDir: join(homedir(), ".trae", "skills"),
      rulesDir: join(homedir(), ".trae", "user_rules"),
    },
  },

  exportRepoContext(opts) {
    return exportAgent(traeLayout, opts);
  },

  importRepoContext(bundle, opts) {
    return importAgent(traeLayout, bundle, opts);
  },
};
