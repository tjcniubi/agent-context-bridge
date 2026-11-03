/**
 * Trae (ByteDance Trae IDE / AI coding agent) adapter.
 *
 * Known project paths (verified via docs.trae.ai):
 *   AGENTS.md (requires Settings → Include AGENTS.md in context)
 *   .trae/rules/*.md  (YAML frontmatter: alwaysApply, description, globs)
 *   .trae/skills/<name>/SKILL.md
 *   .trae/mcp.json    (needs "Enable Project MCP" toggle)
 *   .agents/skills/   (optional shared convention)
 *
 * User scope:
 *   ~/.trae/user_rules
 *   ~/.trae/skills/
 *   User MCP / memories: app-managed UI — no stable documented file
 *
 * Transcripts (Layer 3 — largely blocked):
 *   Encrypted SQLCipher DB under Application Support / AppData
 *   e.g. ~/Library/Application Support/Trae CN/ModularData/ai-agent/database.db
 *   Prefer Trae's built-in Export Chat when available.
 */
import { basename, join, relative } from "node:path";
import { homedir } from "node:os";
import type { AgentAdapter, ExportOptions, ImportOptions } from "./types.js";
import type {
  AgentWorkBundle,
  LossReportEntry,
  McpServerEntry,
  RuleEntry,
  SkillEntry,
} from "../protocol/types.js";
import {
  emptyRepoContext,
  emptyWorkState,
} from "../protocol/types.js";
import { loss } from "../utils/loss-report.js";
import {
  isDirectory,
  listFilesRecursive,
  readJsonIfExists,
  readTextIfExists,
  writeText,
} from "../utils/fs.js";
import { renderWorkStateMarkdown } from "./cursor.js";

function parseYamlishFrontmatter(content: string): {
  always_apply?: boolean;
  description?: string;
  globs?: string[];
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: content };
  const fm = match[1];
  const body = match[2] ?? "";
  const get = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim().replace(/^["']|["']$/g, "");
  };
  const always = get("alwaysApply") ?? get("always_apply");
  const description = get("description");
  const globsRaw = get("globs");
  let globs: string[] | undefined;
  if (globsRaw) {
    globs = globsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return {
    always_apply: always === undefined ? undefined : always === "true",
    description,
    globs,
    body,
  };
}

async function loadSkillsFromDir(
  dir: string,
  projectRoot: string,
): Promise<SkillEntry[]> {
  if (!(await isDirectory(dir))) return [];
  const skillFiles = await listFilesRecursive(dir, ["SKILL.md"]);
  const skills: SkillEntry[] = [];
  for (const skillPath of skillFiles) {
    const skillDir = join(skillPath, "..");
    const name = basename(skillDir);
    const skill_md = (await readTextIfExists(skillPath)) ?? "";
    skills.push({
      name,
      skill_md,
      source_path: relative(projectRoot, skillDir),
    });
  }
  return skills;
}

export const traeAdapter: AgentAdapter = {
  id: "trae",
  displayName: "Trae",
  paths: {
    project: {
      agentsMd: "AGENTS.md",
      rulesDir: ".trae/rules",
      skillsDir: ".trae/skills",
      mcpJson: ".trae/mcp.json",
      instructionNames: ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"],
    },
    user: {
      skillsDir: join(homedir(), ".trae", "skills"),
      rulesDir: join(homedir(), ".trae", "user_rules"),
    },
  },

  async exportRepoContext(opts: ExportOptions) {
    const losses: LossReportEntry[] = [];
    const root = opts.projectRoot;
    const repo = emptyRepoContext();

    for (const name of this.paths.project.instructionNames) {
      const content = await readTextIfExists(join(root, name));
      if (content !== undefined) {
        if (name === "AGENTS.md") {
          repo.agents_md = content;
          losses.push(
            loss(
              "trae.agents_md.toggle",
              "Trae only loads AGENTS.md when Settings → Rules & Memories → Include AGENTS.md in the context is ON.",
              "info",
              name,
            ),
          );
        }
        repo.instructions_files.push({
          name,
          content,
          source_path: name,
        });
      }
    }

    const rulesDir = join(root, this.paths.project.rulesDir);
    const ruleFiles = await listFilesRecursive(rulesDir, [".md", ".mdc"]);
    for (const file of ruleFiles) {
      const content = (await readTextIfExists(file)) ?? "";
      const rel = relative(root, file);
      const meta = parseYamlishFrontmatter(content);
      const entry: RuleEntry = {
        name: relative(rulesDir, file).replace(/\\/g, "/"),
        content,
        source_path: rel,
        always_apply: meta.always_apply,
        description: meta.description,
        globs: meta.globs,
      };
      repo.rules.push(entry);
    }

    // Also discover nested module .trae/rules (documented by Trae)
    // For MVP we only scan project-root .trae/rules; note nested as lossy gap.
    losses.push(
      loss(
        "trae.rules.nested_modules",
        "Subdirectory .trae/rules/ (module-scoped) not scanned in v0.1; only project-root .trae/rules/.",
        "info",
      ),
    );

    for (const sd of [
      join(root, this.paths.project.skillsDir),
      join(root, ".agents", "skills"),
    ]) {
      const found = await loadSkillsFromDir(sd, root);
      for (const s of found) {
        if (!repo.skills.some((x) => x.name === s.name)) repo.skills.push(s);
      }
    }

    const mcpPath = join(root, this.paths.project.mcpJson);
    const mcpJson = await readJsonIfExists<{
      mcpServers?: Record<string, Record<string, unknown>>;
    }>(mcpPath);
    if (mcpJson?.mcpServers) {
      for (const [name, cfg] of Object.entries(mcpJson.mcpServers)) {
        const entry: McpServerEntry = {
          name,
          source_path: this.paths.project.mcpJson,
          config: {
            command: typeof cfg.command === "string" ? cfg.command : undefined,
            args: Array.isArray(cfg.args) ? (cfg.args as string[]) : undefined,
            env:
              cfg.env && typeof cfg.env === "object"
                ? (cfg.env as Record<string, string>)
                : undefined,
            url: typeof cfg.url === "string" ? cfg.url : undefined,
            headers:
              cfg.headers && typeof cfg.headers === "object"
                ? (cfg.headers as Record<string, string>)
                : undefined,
            ...cfg,
          },
        };
        repo.mcp_servers.push(entry);
      }
      losses.push(
        loss(
          "trae.mcp.project_toggle",
          "Trae loads .trae/mcp.json only after Settings → MCP → Enable Project MCP is ON.",
          "info",
          this.paths.project.mcpJson,
        ),
      );
    }

    if (opts.includeUser) {
      losses.push(
        loss(
          "trae.user_scope.partial",
          "User MCP / global rules / memories are largely app-managed (Settings UI). Only ~/.trae/skills and ~/.trae/user_rules have file paths; full user export stubbed.",
          "warn",
        ),
      );
    }

    losses.push(
      loss(
        "work_state.not_inferred",
        "Layer 1 work_state summarization is not implemented; empty work_state emitted.",
        "info",
      ),
    );

    if (opts.sessionId) {
      losses.push(
        loss(
          "transcript.trae_encrypted",
          "Trae chat history lives in an encrypted ModularData/ai-agent/database.db (SQLCipher). Automated export is not implemented; use Trae Export Chat if available.",
          "error",
          opts.sessionId,
        ),
      );
    } else {
      losses.push(
        loss(
          "transcript.skipped",
          "No --session provided; transcript layer skipped. Trae transcripts are encrypted and project-bound.",
          "info",
        ),
      );
    }

    const bundle: AgentWorkBundle = {
      manifest: {
        version: "0.1",
        source_agent: "trae",
        created_at: new Date().toISOString(),
        project_root: root,
        loss_report: losses,
      },
      repo_context: repo,
      work_state: emptyWorkState(),
    };

    return { bundle, losses };
  },

  async importRepoContext(bundle, opts: ImportOptions) {
    const losses: LossReportEntry[] = [...bundle.manifest.loss_report];
    const written: string[] = [];
    const root = opts.projectRoot;
    const rc = bundle.repo_context;

    const write = async (rel: string, content: string) => {
      const full = join(root, rel);
      if (!opts.dryRun) await writeText(full, content);
      written.push(rel);
    };

    const agents =
      rc.agents_md ??
      rc.instructions_files.find((f) => f.name === "AGENTS.md")?.content;
    if (agents !== undefined) {
      await write("AGENTS.md", agents);
      losses.push(
        loss(
          "trae.agents_md.toggle",
          "After import, enable Settings → Include AGENTS.md in the context.",
          "warn",
          "AGENTS.md",
        ),
      );
    }

    for (const f of rc.instructions_files) {
      if (f.name === "AGENTS.md") continue;
      await write(f.name, f.content);
    }

    for (const rule of rc.rules) {
      let name = rule.name;
      // Cursor .mdc → Trae .md
      if (name.endsWith(".mdc")) {
        const newName = name.replace(/\.mdc$/, ".md");
        losses.push(
          loss(
            "trae.rules.ext_normalized",
            `Renamed ${name} → ${newName} for Trae (markdown rules).`,
            "info",
            name,
          ),
        );
        name = newName;
      }
      if (!name.endsWith(".md")) name = `${name}.md`;

      let content = rule.content;
      if (!content.trimStart().startsWith("---")) {
        const lines = ["---"];
        if (rule.description) lines.push(`description: ${rule.description}`);
        if (rule.globs?.length) lines.push(`globs: ${rule.globs.join(",")}`);
        lines.push(`alwaysApply: ${rule.always_apply ?? true}`);
        lines.push("---", "", content);
        content = lines.join("\n");
      }
      await write(join(this.paths.project.rulesDir, name), content);
    }

    for (const skill of rc.skills) {
      await write(
        join(this.paths.project.skillsDir, skill.name, "SKILL.md"),
        skill.skill_md,
      );
      if (skill.extras) {
        for (const [rel, body] of Object.entries(skill.extras)) {
          await write(
            join(this.paths.project.skillsDir, skill.name, rel),
            body,
          );
        }
      }
    }

    if (rc.mcp_servers.length > 0) {
      const mcpServers: Record<string, unknown> = {};
      for (const s of rc.mcp_servers) {
        const cfg: Record<string, unknown> = { ...s.config };
        for (const k of Object.keys(cfg)) {
          if (cfg[k] === undefined) delete cfg[k];
        }
        // Trae docs: no type field required for stdio
        mcpServers[s.name] = cfg;
      }
      await write(
        this.paths.project.mcpJson,
        JSON.stringify({ mcpServers }, null, 2) + "\n",
      );
      losses.push(
        loss(
          "trae.mcp.project_toggle",
          "Enable Project MCP in Trae Settings after import.",
          "warn",
          this.paths.project.mcpJson,
        ),
      );
    }

    if (
      bundle.work_state.goal ||
      bundle.work_state.decisions.length ||
      bundle.work_state.open_loops.length
    ) {
      await write(".acb/WORK_STATE.md", renderWorkStateMarkdown(bundle));
      losses.push(
        loss(
          "work_state.sidecar",
          "Wrote .acb/WORK_STATE.md for manual @ ingest in Trae.",
          "info",
          ".acb/WORK_STATE.md",
        ),
      );
    }

    if (bundle.transcript) {
      losses.push(
        loss(
          "transcript.import_not_implemented",
          "Cannot write into Trae's encrypted chat DB; transcript stays in the bundle JSON.",
          "warn",
        ),
      );
    }

    return { written, losses };
  },
};
