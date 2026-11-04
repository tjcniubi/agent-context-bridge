/**
 * Cursor adapter — Layer 0 (repo durable context) implemented;
 * Layer 1–3 stubbed via loss_report.
 *
 * Known project paths:
 *   AGENTS.md
 *   .cursor/rules/*.mdc
 *   .cursor/skills/<name>/SKILL.md
 *   .cursor/mcp.json
 *   .agents/skills/ (shared convention, also discovered)
 *
 * User scope (optional):
 *   ~/.cursor/mcp.json
 *   ~/.cursor/skills/
 *   ~/.cursor/rules/
 *
 * Transcripts (Layer 3, not yet imported):
 *   ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
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
  hasWorkStateContent,
  renderWorkStateMarkdown,
} from "../protocol/work-state-markdown.js";
import {
  listFilesRecursive,
  readJsonIfExists,
  readTextIfExists,
  writeText,
  isDirectory,
} from "../utils/fs.js";

function parseMdcFrontmatter(content: string): {
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
    // Support "a,b" or ["a","b"]
    if (globsRaw.startsWith("[")) {
      try {
        globs = JSON.parse(globsRaw.replace(/'/g, '"')) as string[];
      } catch {
        globs = [globsRaw];
      }
    } else {
      globs = globsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    }
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

export const cursorAdapter: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  paths: {
    project: {
      agentsMd: "AGENTS.md",
      rulesDir: ".cursor/rules",
      skillsDir: ".cursor/skills",
      mcpJson: ".cursor/mcp.json",
      instructionNames: ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"],
    },
    user: {
      mcpJson: join(homedir(), ".cursor", "mcp.json"),
      skillsDir: join(homedir(), ".cursor", "skills"),
      rulesDir: join(homedir(), ".cursor", "rules"),
    },
  },

  async exportRepoContext(opts: ExportOptions) {
    const losses: LossReportEntry[] = [];
    const root = opts.projectRoot;
    const repo = emptyRepoContext();

    // AGENTS.md + other instruction files
    for (const name of this.paths.project.instructionNames) {
      const path = join(root, name);
      const content = await readTextIfExists(path);
      if (content !== undefined) {
        if (name === "AGENTS.md") repo.agents_md = content;
        repo.instructions_files.push({
          name,
          content,
          source_path: name,
        });
      }
    }

    // Rules (.mdc preferred; .md noted as ignored by Cursor)
    const rulesDir = join(root, this.paths.project.rulesDir);
    const ruleFiles = await listFilesRecursive(rulesDir, [".mdc", ".md"]);
    for (const file of ruleFiles) {
      const content = (await readTextIfExists(file)) ?? "";
      const rel = relative(root, file);
      if (file.endsWith(".md") && !file.endsWith(".mdc")) {
        losses.push(
          loss(
            "cursor.rules.md_ignored",
            "Cursor ignores plain .md in .cursor/rules (no frontmatter). Exported into bundle anyway for Trae/interop.",
            "info",
            rel,
          ),
        );
      }
      const meta = parseMdcFrontmatter(content);
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

    // Skills: .cursor/skills and .agents/skills
    const skillDirs = [
      join(root, this.paths.project.skillsDir),
      join(root, ".agents", "skills"),
    ];
    for (const sd of skillDirs) {
      const found = await loadSkillsFromDir(sd, root);
      for (const s of found) {
        if (!repo.skills.some((x) => x.name === s.name)) repo.skills.push(s);
      }
    }

    // MCP
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
    }

    if (opts.includeUser) {
      losses.push(
        loss(
          "cursor.user_scope.stub",
          "User-scope export (~/.cursor/mcp.json, skills, rules) is not fully implemented yet; project scope only.",
          "warn",
        ),
      );
    }

    // Layer 1–3 stubs
    losses.push(
      loss(
        "work_state.not_inferred",
        "Layer 1 work_state summarization is not implemented; empty work_state emitted. Fill manually or wait for summarize command.",
        "info",
      ),
    );
    if (opts.sessionId) {
      losses.push(
        loss(
          "transcript.not_implemented",
          `Layer 3 transcript export for session ${opts.sessionId} is stubbed. Cursor JSONL lives under ~/.cursor/projects/<slug>/agent-transcripts/.`,
          "warn",
          opts.sessionId,
        ),
      );
    } else {
      losses.push(
        loss(
          "transcript.skipped",
          "No --session provided; transcript layer skipped.",
          "info",
        ),
      );
    }

    const bundle: AgentWorkBundle = {
      manifest: {
        version: "0.1",
        source_agent: "cursor",
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

    // AGENTS.md
    const agents =
      rc.agents_md ??
      rc.instructions_files.find((f) => f.name === "AGENTS.md")?.content;
    if (agents !== undefined) {
      await write("AGENTS.md", agents);
    }

    // Other instruction files (CLAUDE.md etc.) — write if present
    for (const f of rc.instructions_files) {
      if (f.name === "AGENTS.md") continue;
      await write(f.name, f.content);
    }

    // Rules → .cursor/rules/*.mdc
    for (const rule of rc.rules) {
      let name = rule.name;
      // Trae often uses .md; Cursor wants .mdc
      if (name.endsWith(".md") && !name.endsWith(".mdc")) {
        const newName = name.replace(/\.md$/, ".mdc");
        losses.push(
          loss(
            "cursor.rules.ext_normalized",
            `Renamed ${name} → ${newName} for Cursor (.mdc required).`,
            "info",
            name,
          ),
        );
        name = newName;
      }
      if (!name.endsWith(".mdc") && !name.endsWith(".md")) {
        name = `${name}.mdc`;
      }
      // Ensure usable frontmatter if missing
      let content = rule.content;
      if (!content.trimStart().startsWith("---")) {
        const lines = ["---"];
        if (rule.description) lines.push(`description: ${rule.description}`);
        if (rule.globs?.length) lines.push(`globs: ${rule.globs.join(",")}`);
        if (rule.always_apply !== undefined)
          lines.push(`alwaysApply: ${rule.always_apply}`);
        if (lines.length === 1) lines.push("alwaysApply: true");
        lines.push("---", "", content);
        content = lines.join("\n");
        losses.push(
          loss(
            "cursor.rules.frontmatter_added",
            "Added minimal frontmatter so Cursor will load the rule.",
            "info",
            name,
          ),
        );
      }
      await write(join(this.paths.project.rulesDir, name), content);
    }

    // Skills → .cursor/skills/<name>/SKILL.md
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

    // MCP → .cursor/mcp.json
    if (rc.mcp_servers.length > 0) {
      const mcpServers: Record<string, unknown> = {};
      for (const s of rc.mcp_servers) {
        const cfg: Record<string, unknown> = { ...s.config };
        // Strip undefined
        for (const k of Object.keys(cfg)) {
          if (cfg[k] === undefined) delete cfg[k];
        }
        mcpServers[s.name] = cfg;
      }
      await write(
        this.paths.project.mcpJson,
        JSON.stringify({ mcpServers }, null, 2) + "\n",
      );
    }

    // Work state / transcript not written as native Cursor files yet
    if (hasWorkStateContent(bundle)) {
      await write(
        ".acb/WORK_STATE.md",
        renderWorkStateMarkdown(bundle),
      );
      losses.push(
        loss(
          "work_state.sidecar",
          "Cursor has no native Work State file; wrote .acb/WORK_STATE.md for @-mention / manual ingest.",
          "info",
          ".acb/WORK_STATE.md",
        ),
      );
    }

    if (bundle.transcript) {
      losses.push(
        loss(
          "transcript.import_not_implemented",
          "Cannot inject lossy transcript into Cursor chat UI yet; bundle.transcript preserved in JSON only.",
          "warn",
        ),
      );
    }

    return { written, losses };
  },
};
