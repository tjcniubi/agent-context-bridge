import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { FileChange, ExportOptions, ImportOptions } from "./types.js";
import type {
  AgentWorkBundle,
  ContextScope,
  InstructionsFile,
  LossReportEntry,
  McpServerEntry,
  RepoContext,
  RuleEntry,
  SkillEntry,
} from "../protocol/types.js";
import { emptyRepoContext, emptyWorkState } from "../protocol/types.js";
import { hasWorkStateContent, renderWorkStateMarkdown } from "../protocol/work-state-markdown.js";
import { collectTranscript } from "../transcript/collect.js";
import { TRANSCRIPT_SIDECAR } from "../transcript/limits.js";
import { renderTranscriptMarkdown } from "../transcript/render.js";
import { exists, isDirectory, readTextCapped, writeText } from "../utils/fs.js";
import { loss } from "../utils/loss-report.js";
import { resolveInside, safeName, safeRelative } from "../utils/path-safety.js";
import { parseFrontmatter, ruleContentForTarget, withRuleExtension } from "./frontmatter.js";
import { walkProject } from "./walk.js";

const MAX_TEXT = 512 * 1024;
const MAX_SKILL_EXTRA = 200 * 1024;
const TEXT_EXTRAS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sh",
  ".css",
  ".html",
  ".xml",
  ".csv",
  ".rst",
  ".ini",
  ".cfg",
]);
const INSTRUCTIONS = new Set(["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"]);
const PORTABLE_MCP = new Set(["command", "args", "env", "url", "headers"]);

export interface AgentLayout {
  id: "cursor" | "trae";
  rulesDir: string;
  skillsDir: string;
  mcpJson: string;
  otherRulesDir: string;
  otherSkillsDir: string;
  otherMcpJson: string;
}

export const cursorLayout: AgentLayout = {
  id: "cursor",
  rulesDir: ".cursor/rules",
  skillsDir: ".cursor/skills",
  mcpJson: ".cursor/mcp.json",
  otherRulesDir: ".trae/rules",
  otherSkillsDir: ".trae/skills",
  otherMcpJson: ".trae/mcp.json",
};

export const traeLayout: AgentLayout = {
  id: "trae",
  rulesDir: ".trae/rules",
  skillsDir: ".trae/skills",
  mcpJson: ".trae/mcp.json",
  otherRulesDir: ".cursor/rules",
  otherSkillsDir: ".cursor/skills",
  otherMcpJson: ".cursor/mcp.json",
};

export function isUserScoped(entry: { scope?: ContextScope; source_path?: string }): boolean {
  return entry.scope === "user" || Boolean(entry.source_path?.startsWith("user:"));
}

interface Planned {
  ok: true;
  change: FileChange;
}

async function writeMapped(
  root: string,
  rel: string,
  content: string,
  dryRun: boolean,
  display = rel,
): Promise<Planned | { ok: false; reason: string }> {
  const safe = safeRelative(rel);
  if (!safe) return { ok: false, reason: "escape" };
  const abs = await resolveInside(root, safe);
  if (!abs) return { ok: false, reason: "escape" };
  let existing: string | undefined;
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { ok: false, reason: "not-file" };
    existing = await readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") existing = undefined;
    else return { ok: false, reason: (err as Error).message };
  }
  const action: FileChange["action"] =
    existing === undefined ? "create" : existing === content ? "unchanged" : "update";
  if (!dryRun && action !== "unchanged") await writeText(abs, content);
  return { ok: true, change: { path: display, action } };
}

function remember(
  written: string[],
  changes: FileChange[],
  planned: Planned | { ok: false; reason: string },
  losses: LossReportEntry[],
  rel: string,
): void {
  if (!planned.ok) {
    losses.push(
      loss(
        planned.reason === "escape" ? "write.path_rejected" : "write.unreadable",
        planned.reason === "escape"
          ? `Refused to write ${rel} because it escapes the destination root.`
          : `Could not write ${rel}: ${planned.reason}`,
        "error",
        rel,
      ),
    );
    return;
  }
  changes.push(planned.change);
  written.push(planned.change.path);
}

async function readCapped(
  abs: string,
  max: number,
  losses: LossReportEntry[],
  label: string,
): Promise<string | undefined> {
  const capped = await readTextCapped(abs, max);
  if (!capped) return undefined;
  if (capped.truncated) {
    losses.push(loss("scan.file_truncated", `Truncated ${label} to ${max} bytes.`, "warn", label));
  }
  return capped.text;
}

function ruleFromFile(rel: string, content: string, scope: ContextScope): RuleEntry | undefined {
  const match = rel.match(/^(?:(.+?)\/)?(\.cursor\/rules|\.trae\/rules)\/(.+\.(?:md|mdc))$/);
  if (!match) return undefined;
  const parsed = parseFrontmatter(content);
  return {
    name: match[3],
    content,
    source_path: scope === "user" ? `user:${rel}` : rel,
    scope,
    ...(parsed.always_apply !== undefined ? { always_apply: parsed.always_apply } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(parsed.globs && parsed.globs.length > 0 ? { globs: parsed.globs } : {}),
  };
}

function isInstruction(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  if (!INSTRUCTIONS.has(base)) return false;
  if (rel.startsWith(".cursor/") || rel.startsWith(".trae/") || rel.includes("/.cursor/") || rel.includes("/.trae/")) {
    return false;
  }
  if (rel.startsWith(".agents/skills/") || rel.includes("/.agents/skills/")) return false;
  return true;
}

async function loadSkillDir(
  skillDir: string,
  name: string,
  sourcePath: string,
  scope: ContextScope,
  losses: LossReportEntry[],
): Promise<SkillEntry | undefined> {
  const skillPath = join(skillDir, "SKILL.md");
  const skillMd = await readCapped(skillPath, MAX_TEXT, losses, `${sourcePath}/SKILL.md`);
  if (skillMd === undefined) return undefined;
  const extras: Record<string, string> = {};
  const binary: string[] = [];
  const files: { abs: string; rel: string }[] = [];
  async function rec(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) {
        losses.push(loss("skills.symlink_skipped", `Skipped symlink in skill ${name}.`, "info", `${sourcePath}/${ent.name}`));
        continue;
      }
      const abs = join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".git") continue;
        await rec(abs, rel);
      } else if (ent.isFile() && rel !== "SKILL.md") {
        files.push({ abs, rel });
      }
    }
  }
  await rec(skillDir, "");
  for (const file of files) {
    const safe = safeRelative(file.rel);
    if (!safe) {
      losses.push(loss("skills.extra_path", `Skipped unsafe extra path in skill ${name}.`, "warn", file.rel));
      continue;
    }
    const ext = extname(file.rel).toLowerCase();
    if (!TEXT_EXTRAS.has(ext)) {
      binary.push(file.rel);
      continue;
    }
    const body = await readCapped(file.abs, MAX_SKILL_EXTRA, losses, `${sourcePath}/${safe}`);
    if (body !== undefined) extras[safe] = body;
  }
  if (binary.length > 0) {
    losses.push(
      loss(
        "skills.binary_omitted",
        `Omitted non-text files from skill ${name}: ${binary.slice(0, 8).join(", ")}`,
        "info",
        sourcePath,
      ),
    );
  }
  return {
    name,
    skill_md: skillMd,
    source_path: sourcePath,
    scope,
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
}

function skillRank(rel: string, layout: AgentLayout): number {
  if (rel.startsWith(`${layout.skillsDir}/`) || rel.includes(`/${layout.skillsDir}/`)) return 0;
  if (rel.startsWith(".agents/skills/") || rel.includes("/.agents/skills/")) return 1;
  return 2;
}

function skillOwns(sourcePath: string, layout: AgentLayout): boolean {
  return (
    sourcePath.startsWith(`${layout.skillsDir}/`) ||
    sourcePath.includes(`/${layout.skillsDir}/`) ||
    sourcePath.startsWith(".agents/skills/") ||
    sourcePath.includes("/.agents/skills/")
  );
}

function skillDest(sourcePath: string | undefined, name: string, layout: AgentLayout): string {
  const norm = (sourcePath ?? "").replace(/\\/g, "/").replace(/^user:/, "");
  const match = norm.match(/^(.*?)(?:^|\/)?(?:\.cursor\/skills|\.trae\/skills|\.agents\/skills)\/([^/]+)$/);
  if (!match) return `${layout.skillsDir}/${name}`;
  const moduleDir = match[1].replace(/\/$/, "");
  return `${moduleDir ? `${moduleDir}/` : ""}${layout.skillsDir}/${name}`;
}

async function scanProject(repo: RepoContext, layout: AgentLayout, projectRoot: string, losses: LossReportEntry[]): Promise<void> {
  const walked = await walkProject(projectRoot);
  if (walked.truncated) {
    losses.push(loss("scan.truncated", "Project scan stopped after the file or depth limit. Some nested files may be missing.", "warn"));
  }
  for (const rel of walked.unreadable) {
    losses.push(loss("scan.unreadable", `Could not read directory ${rel}.`, "warn", rel));
  }

  const instructions = walked.files.filter((file) => isInstruction(file.rel)).sort((a, b) => a.rel.localeCompare(b.rel));
  for (const file of instructions) {
    const content = await readCapped(file.abs, MAX_TEXT, losses, file.rel);
    if (content === undefined) continue;
    const entry: InstructionsFile = {
      name: file.rel.includes("/") ? file.rel : file.rel,
      content,
      source_path: file.rel,
      scope: "project",
    };
    repo.instructions_files.push(entry);
    if (file.rel === "AGENTS.md") repo.agents_md = content;
  }
  if (layout.id === "trae" && repo.agents_md !== undefined) {
    losses.push(
      loss(
        "trae.agents_md.toggle",
        "Trae only loads AGENTS.md when Settings → Rules & Memories → Include AGENTS.md in the context is ON.",
        "info",
        "AGENTS.md",
      ),
    );
  }

  let otherLayout = false;
  const rules = walked.files
    .filter((file) => /(?:^|\/)(?:\.cursor\/rules|\.trae\/rules)\/.+\.(?:md|mdc)$/.test(file.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  for (const file of rules) {
    const content = await readCapped(file.abs, MAX_TEXT, losses, file.rel);
    if (content === undefined) continue;
    const entry = ruleFromFile(file.rel, content, "project");
    if (!entry) continue;
    if (!file.rel.includes(layout.rulesDir)) otherLayout = true;
    if (layout.id === "cursor" && file.rel.includes(".cursor/rules/") && file.rel.endsWith(".md") && !file.rel.endsWith(".mdc")) {
      losses.push(
        loss(
          "cursor.rules.md_ignored",
          "Cursor ignores plain .md in .cursor/rules. Exported into the bundle anyway.",
          "info",
          file.rel,
        ),
      );
    }
    repo.rules.push(entry);
  }

  const skillFiles = walked.files
    .filter((file) => /(?:^|\/)(?:\.cursor\/skills|\.trae\/skills|\.agents\/skills)\/[^/]+\/SKILL\.md$/.test(file.rel))
    .sort((a, b) => skillRank(a.rel, layout) - skillRank(b.rel, layout) || a.rel.localeCompare(b.rel));
  const seenSkills = new Map<string, SkillEntry>();
  for (const file of skillFiles) {
    const match = file.rel.match(/^(?:\.cursor\/skills|\.trae\/skills|\.agents\/skills|.*\/(?:\.cursor\/skills|\.trae\/skills|\.agents\/skills))\/([^/]+)\/SKILL\.md$/);
    if (!match) continue;
    const name = match[1];
    const sourcePath = file.rel.slice(0, -"/SKILL.md".length);
    if (!skillOwns(sourcePath, layout)) otherLayout = true;
    const loaded = await loadSkillDir(join(projectRoot, sourcePath), name, sourcePath, "project", losses);
    if (!loaded) continue;
    const prev = seenSkills.get(name);
    if (!prev) {
      seenSkills.set(name, loaded);
      continue;
    }
    if (prev.skill_md !== loaded.skill_md) {
      losses.push(
        loss(
          "skills.duplicate_skipped",
          `Kept ${prev.source_path} for skill ${name} and skipped ${sourcePath}.`,
          "info",
          sourcePath,
        ),
      );
    }
  }
  repo.skills.push(...seenSkills.values());

  const nestedMcp = walked.files.filter(
    (file) =>
      /(?:^|\/)(?:\.cursor|\.trae)\/mcp\.json$/.test(file.rel) &&
      file.rel !== layout.mcpJson &&
      file.rel !== layout.otherMcpJson,
  );
  if (nestedMcp.length > 0) {
    losses.push(
      loss(
        "mcp.nested_not_read",
        `Left nested mcp.json unread (${nestedMcp
          .slice(0, 5)
          .map((file) => file.rel)
          .join(", ")}). Only the project-root MCP files are portable.`,
        "info",
        nestedMcp[0].rel,
      ),
    );
  }

  const seenMcp = new Set<string>();
  for (const rel of [layout.mcpJson, layout.otherMcpJson]) {
    const abs = await resolveInside(projectRoot, rel);
    if (!abs) {
      losses.push(loss("user_scope.symlink_skipped", `Skipped ${rel} because it resolves outside the project.`, "warn", rel));
      continue;
    }
    if (!(await exists(abs))) continue;
    if (rel !== layout.mcpJson) otherLayout = true;
    await readMcpFile(abs, rel, "project", repo, seenMcp, losses);
  }
  if (layout.id === "trae" && repo.mcp_servers.some((server) => !isUserScoped(server) && server.source_path === layout.mcpJson)) {
    losses.push(
      loss(
        "trae.mcp.project_toggle",
        "Trae loads .trae/mcp.json only after Settings → MCP → Enable Project MCP is ON.",
        "info",
        layout.mcpJson,
      ),
    );
  }
  if (otherLayout) {
    losses.push(
      loss(
        "repo.other_layout_included",
        "Also read the other agent's project rules, skills, or MCP so the bundle can be mapped either way.",
        "info",
      ),
    );
  }
}

function stringRecord(
  value: unknown,
  losses: LossReportEntry[],
  path: string,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  let dropped = false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
    else dropped = true;
  }
  if (dropped) {
    losses.push(loss("mcp.env.non_string", "Dropped non-scalar MCP env or header values.", "warn", path));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function redact(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record)) out[key] = "${REDACTED}";
  return out;
}

async function readMcpFile(
  abs: string,
  sourcePath: string,
  scope: ContextScope,
  repo: RepoContext,
  seen: Set<string>,
  losses: LossReportEntry[],
): Promise<void> {
  let parsed: { mcpServers?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(await readFile(abs, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
  } catch (err) {
    losses.push(loss("mcp.unreadable", `Could not parse ${sourcePath}: ${(err as Error).message}`, "error", sourcePath));
    return;
  }
  if (!parsed?.mcpServers || typeof parsed.mcpServers !== "object") return;
  for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
    if (!cfg || typeof cfg !== "object") continue;
    if (seen.has(name)) {
      losses.push(loss("mcp.duplicate_name", `Kept the first MCP server named ${name} and skipped ${sourcePath}.`, "info", sourcePath));
      continue;
    }
    seen.add(name);
    const env = stringRecord(cfg.env, losses, name);
    const headers = stringRecord(cfg.headers, losses, name);
    let finalEnv = env;
    let finalHeaders = headers;
    if (scope === "user" && env) {
      finalEnv = redact(env);
      losses.push(loss("mcp.env.redacted", `Redacted user-scope env for MCP server ${name}.`, "warn", name));
    } else if (env) {
      losses.push(
        loss(
          "mcp.env.unredacted",
          `Project MCP server ${name} keeps env values in the bundle. Do not commit this file.`,
          "warn",
          name,
        ),
      );
    }
    if (scope === "user" && headers) {
      finalHeaders = redact(headers);
      losses.push(loss("mcp.headers.redacted", `Redacted user-scope headers for MCP server ${name}.`, "warn", name));
    }
    const args = Array.isArray(cfg.args) ? cfg.args.filter((item): item is string => typeof item === "string") : undefined;
    if (Array.isArray(cfg.args) && args && args.length !== cfg.args.length) {
      losses.push(loss("mcp.args.non_string", `Dropped non-string args for MCP server ${name}.`, "warn", name));
    }
    const config: McpServerEntry["config"] = {};
    for (const [key, value] of Object.entries(cfg)) {
      if (!PORTABLE_MCP.has(key) && value !== undefined) config[key] = value;
    }
    if (typeof cfg.command === "string") config.command = cfg.command;
    if (args && args.length > 0) config.args = args;
    if (finalEnv) config.env = finalEnv;
    if (typeof cfg.url === "string") config.url = cfg.url;
    if (finalHeaders) config.headers = finalHeaders;
    repo.mcp_servers.push({
      name,
      source_path: scope === "user" ? `user:${sourcePath}` : sourcePath,
      scope,
      config,
    });
  }
}

async function readUserScope(repo: RepoContext, layout: AgentLayout, home: string, losses: LossReportEntry[]): Promise<void> {
  const rootName = layout.id === "cursor" ? ".cursor" : ".trae";
  const base = join(home, rootName);
  if (layout.id === "cursor") {
    losses.push(
      loss(
        "cursor.user_rules.account_only",
        "Cursor account User Rules have no stable file. Only ~/.cursor/rules, skills, and mcp.json can be read.",
        "info",
        ".cursor/rules",
      ),
    );
  } else {
    losses.push(
      loss(
        "trae.user_mcp.unavailable",
        "Trae user MCP and memories are app-managed. They were not read, and the encrypted local database was not opened.",
        "warn",
      ),
    );
  }
  if (!(await exists(base))) {
    losses.push(
      loss(
        `${layout.id}.user_scope.absent`,
        `No ${rootName} directory in the home used for --include-user.`,
        "info",
        rootName,
      ),
    );
    return;
  }
  const baseInside = await resolveInside(home, rootName);
  if (!baseInside) {
    losses.push(
      loss(
        "user_scope.symlink_skipped",
        `Skipped ${rootName} because it resolves outside the home directory.`,
        "warn",
        rootName,
      ),
    );
    return;
  }

  if (layout.id === "cursor") {
    const mcpAbs = await resolveInside(home, ".cursor/mcp.json");
    if (!mcpAbs) {
      losses.push(loss("user_scope.symlink_skipped", "Skipped ~/.cursor/mcp.json because it escapes the home directory.", "warn", ".cursor/mcp.json"));
    } else if (await exists(mcpAbs)) {
      await readMcpFile(mcpAbs, ".cursor/mcp.json", "user", repo, new Set(repo.mcp_servers.map((server) => server.name)), losses);
    }
    await readUserSkills(home, ".cursor/skills", repo, losses);
    await readUserRules(home, ".cursor/rules", repo, losses);
    return;
  }

  await readUserSkills(home, ".trae/skills", repo, losses);
  await readTraeUserRules(home, repo, losses);
}

async function readUserSkills(home: string, relDir: string, repo: RepoContext, losses: LossReportEntry[]): Promise<void> {
  const abs = await resolveInside(home, relDir);
  if (!abs) {
    losses.push(loss("user_scope.symlink_skipped", `Skipped ${relDir} because it escapes the home directory.`, "warn", relDir));
    return;
  }
  if (!(await isDirectory(abs))) return;
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    losses.push(loss("scan.unreadable", `Could not read ${relDir}.`, "warn", relDir));
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    const name = safeName(ent.name);
    if (!name) continue;
    if (repo.skills.some((skill) => skill.name === name && skill.scope === "user")) continue;
    const loaded = await loadSkillDir(join(abs, ent.name), name, `user:${relDir}/${name}`, "user", losses);
    if (loaded) repo.skills.push(loaded);
  }
}

async function readUserRules(home: string, relDir: string, repo: RepoContext, losses: LossReportEntry[]): Promise<void> {
  const abs = await resolveInside(home, relDir);
  if (!abs) {
    losses.push(loss("user_scope.symlink_skipped", `Skipped ${relDir} because it escapes the home directory.`, "warn", relDir));
    return;
  }
  if (!(await isDirectory(abs))) return;
  const files: { abs: string; rel: string }[] = [];
  async function rec(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) {
        losses.push(loss("user_scope.symlink_skipped", `Skipped symlink ${prefix}${ent.name} under ${relDir}.`, "info", `${relDir}/${prefix}${ent.name}`));
        continue;
      }
      const child = join(dir, ent.name);
      const rel = `${prefix}${ent.name}`;
      if (ent.isDirectory()) await rec(child, `${rel}/`);
      else if (ent.isFile() && (ent.name.endsWith(".md") || ent.name.endsWith(".mdc"))) {
        files.push({ abs: child, rel: `${relDir}/${rel}` });
      }
    }
  }
  try {
    await rec(abs, "");
  } catch {
    losses.push(loss("scan.unreadable", `Could not read ${relDir}.`, "warn", relDir));
    return;
  }
  for (const file of files) {
    const content = await readCapped(file.abs, MAX_TEXT, losses, file.rel);
    if (content === undefined) continue;
    const entry = ruleFromFile(file.rel, content, "user");
    if (entry) repo.rules.push(entry);
  }
}

async function readTraeUserRules(home: string, repo: RepoContext, losses: LossReportEntry[]): Promise<void> {
  const rel = ".trae/user_rules";
  const abs = await resolveInside(home, rel);
  if (!abs) {
    losses.push(loss("user_scope.symlink_skipped", "Skipped ~/.trae/user_rules because it escapes the home directory.", "warn", rel));
    return;
  }
  let info;
  try {
    info = await stat(abs);
  } catch {
    return;
  }
  if (info.isFile()) {
    const content = await readCapped(abs, MAX_TEXT, losses, rel);
    if (content === undefined) return;
    const parsed = parseFrontmatter(content);
    repo.rules.push({
      name: "user_rules",
      content,
      source_path: "user:.trae/user_rules",
      scope: "user",
      ...(parsed.always_apply !== undefined ? { always_apply: parsed.always_apply } : {}),
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.globs?.length ? { globs: parsed.globs } : {}),
    });
    return;
  }
  if (info.isDirectory()) {
    const files: { abs: string; relName: string }[] = [];
    async function rec(dir: string, prefix: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isSymbolicLink()) {
          losses.push(
            loss("user_scope.symlink_skipped", `Skipped symlink in ~/.trae/user_rules.`, "info", `${rel}/${prefix}${ent.name}`),
          );
          continue;
        }
        const child = join(dir, ent.name);
        const relName = `${prefix}${ent.name}`;
        if (ent.isDirectory()) await rec(child, `${relName}/`);
        else if (ent.isFile() && (ent.name.endsWith(".md") || ent.name.endsWith(".mdc"))) {
          files.push({ abs: child, relName });
        }
      }
    }
    try {
      await rec(abs, "");
    } catch {
      losses.push(loss("scan.unreadable", "Could not read ~/.trae/user_rules.", "warn", rel));
      return;
    }
    for (const file of files) {
      const content = await readCapped(file.abs, MAX_TEXT, losses, `${rel}/${file.relName}`);
      if (content === undefined) continue;
      const parsed = parseFrontmatter(content);
      repo.rules.push({
        name: file.relName,
        content,
        source_path: `user:.trae/user_rules/${file.relName}`,
        scope: "user",
        ...(parsed.always_apply !== undefined ? { always_apply: parsed.always_apply } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.globs?.length ? { globs: parsed.globs } : {}),
      });
    }
  }
}

function splitRule(sourcePath: string | undefined, name: string): { moduleDir: string; ruleRel: string } {
  const fallback = name.replace(/\\/g, "/");
  if (!sourcePath || sourcePath.startsWith("user:")) return { moduleDir: "", ruleRel: fallback };
  const norm = sourcePath.replace(/\\/g, "/");
  const match = norm.match(/^(.*?)(?:^|\/)?(?:\.cursor\/rules|\.trae\/rules)\/(.+)$/);
  if (!match) return { moduleDir: "", ruleRel: fallback };
  return { moduleDir: match[1].replace(/\/$/, ""), ruleRel: match[2] };
}

function cleanConfig(config: McpServerEntry["config"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export async function exportAgent(
  layout: AgentLayout,
  opts: ExportOptions,
): Promise<{ bundle: AgentWorkBundle; losses: LossReportEntry[] }> {
  const losses: LossReportEntry[] = [];
  const repo = emptyRepoContext();
  const home = opts.userHome ?? homedir();
  await scanProject(repo, layout, opts.projectRoot, losses);
  if (opts.includeUser) await readUserScope(repo, layout, home, losses);

  losses.push(
    loss(
      "work_state.not_inferred",
      "Work State is not inferred from the session. The bundle ships an empty work_state until you fill it or confirm a repair.",
      "info",
    ),
  );

  let transcript: AgentWorkBundle["transcript"];
  if (opts.includeTranscript || opts.sessionId) {
    const collected = await collectTranscript(layout.id, { ...opts, userHome: home });
    losses.push(...collected.losses);
    transcript = collected.transcript;
  } else {
    losses.push(loss("transcript.skipped", "Transcript layer skipped. Pass --include-transcript or --session to read a lossy transcript.", "info"));
  }

  const bundle: AgentWorkBundle = {
    manifest: {
      version: "0.1",
      source_agent: layout.id,
      created_at: new Date().toISOString(),
      project_root: opts.projectRoot,
      loss_report: losses,
    },
    repo_context: repo,
    work_state: emptyWorkState(),
    ...(transcript ? { transcript } : {}),
  };
  return { bundle, losses };
}

export async function importAgent(
  layout: AgentLayout,
  bundle: AgentWorkBundle,
  opts: ImportOptions,
): Promise<{ written: string[]; losses: LossReportEntry[]; changes: FileChange[] }> {
  const losses: LossReportEntry[] = [...bundle.manifest.loss_report];
  const written: string[] = [];
  const changes: FileChange[] = [];
  const dryRun = Boolean(opts.dryRun);
  const home = opts.userHome ?? homedir();
  const rc = bundle.repo_context;

  const put = async (root: string, rel: string, content: string, display = rel) => {
    const planned = await writeMapped(root, rel, content, dryRun, display);
    remember(written, changes, planned, losses, display);
  };

  const seenInstructions = new Set<string>();
  if (rc.agents_md !== undefined) {
    await put(opts.projectRoot, "AGENTS.md", rc.agents_md);
    seenInstructions.add("AGENTS.md");
    if (layout.id === "trae") {
      losses.push(
        loss(
          "trae.agents_md.toggle",
          "After import, enable Settings → Include AGENTS.md in the context.",
          "warn",
          "AGENTS.md",
        ),
      );
    }
  }
  let nestedAgents = false;
  let claude = false;
  for (const file of rc.instructions_files) {
    if (isUserScoped(file)) continue;
    const rel = safeRelative(file.source_path || file.name);
    if (!rel) {
      losses.push(loss("write.path_rejected", `Refused instruction path ${file.name}.`, "error", file.name));
      continue;
    }
    if (seenInstructions.has(rel)) continue;
    seenInstructions.add(rel);
    await put(opts.projectRoot, rel, file.content);
    if (rel.endsWith("/AGENTS.md")) nestedAgents = true;
    if (basename(rel) === "CLAUDE.md" || basename(rel) === "CLAUDE.local.md") claude = true;
  }
  if (layout.id === "trae" && nestedAgents) {
    losses.push(
      loss(
        "trae.agents_md.nested_toggle",
        "Nested AGENTS.md files were written. Trae may only auto-include the root file until that setting is enabled.",
        "info",
      ),
    );
  }
  if (layout.id === "trae" && claude) {
    losses.push(
      loss(
        "trae.instructions.toggle",
        "CLAUDE.md was written. Trae loads it only when the matching include/import setting is ON.",
        "info",
      ),
    );
  }

  const projectRules = rc.rules.filter((rule) => !isUserScoped(rule));
  const seenDest = new Set<string>();
  for (const rule of projectRules) {
    const split = splitRule(rule.source_path, rule.name);
    const ext = withRuleExtension(split.ruleRel, layout.id);
    const prefix = split.moduleDir ? `${split.moduleDir}/` : "";
    const rel = `${prefix}${layout.rulesDir}/${ext.rel}`;
    if (!safeRelative(rel)) {
      losses.push(loss("write.path_rejected", `Refused rule path ${rule.name}.`, "error", rule.name));
      continue;
    }
    if (seenDest.has(rel)) {
      losses.push(loss("rules.dest_collision", `Skipped ${rule.source_path ?? rule.name}; ${rel} was already written.`, "warn", rel));
      continue;
    }
    seenDest.add(rel);
    const shaped = ruleContentForTarget(rule.content, layout.id, rule);
    if (ext.from && ext.to) {
      losses.push(
        loss(
          `${layout.id}.rules.ext_normalized`,
          `Renamed ${ext.from} → ${ext.to} for ${layout.id}.`,
          "info",
          rule.source_path ?? rule.name,
        ),
      );
    }
    if (shaped.addedFrontmatter) {
      losses.push(
        loss(
          `${layout.id}.rules.frontmatter_added`,
          layout.id === "cursor"
            ? "Added minimal frontmatter so Cursor will load the rule."
            : "Added minimal frontmatter so Trae will load the rule.",
          "info",
          rel,
        ),
      );
    }
    if (shaped.normalizedGlobs) {
      losses.push(loss("trae.rules.globs_normalized", "Rewrote structured globs to a comma-separated string.", "info", rel));
    }
    if (shaped.keptScene) {
      losses.push(
        loss(
          "cursor.rules.scene_unsupported",
          "Kept Trae frontmatter key `scene` in the Cursor rule. Cursor does not document that key.",
          "info",
          rel,
        ),
      );
    }
    await put(opts.projectRoot, rel, shaped.content);
  }

  let mappedSharedSkills = false;
  for (const skill of rc.skills) {
    if (isUserScoped(skill)) continue;
    const name = safeName(skill.name);
    if (!name) {
      losses.push(loss("write.path_rejected", `Refused skill name ${skill.name}.`, "error", skill.name));
      continue;
    }
    if (skill.source_path?.includes(".agents/skills")) mappedSharedSkills = true;
    const destDir = skillDest(skill.source_path, name, layout);
    if (!safeRelative(`${destDir}/SKILL.md`)) {
      losses.push(loss("write.path_rejected", `Refused skill path ${destDir}.`, "error", skill.name));
      continue;
    }
    await put(opts.projectRoot, `${destDir}/SKILL.md`, skill.skill_md);
    if (skill.extras) {
      for (const [extraRel, body] of Object.entries(skill.extras)) {
        const safe = safeRelative(extraRel);
        if (!safe) {
          losses.push(loss("skills.extra_path", `Refused extra ${extraRel} in skill ${name}.`, "warn", extraRel));
          continue;
        }
        await put(opts.projectRoot, `${destDir}/${safe}`, body);
      }
    }
  }
  if (mappedSharedSkills) {
    losses.push(
      loss(
        "skills.agents_dir_mapped",
        `Shared .agents/skills entries were written to ${layout.skillsDir}.`,
        "info",
        layout.skillsDir,
      ),
    );
  }

  const projectMcp = rc.mcp_servers.filter((server) => !isUserScoped(server));
  if (projectMcp.length > 0) {
    const mcpServers: Record<string, unknown> = {};
    for (const server of projectMcp) mcpServers[server.name] = cleanConfig(server.config);
    await put(opts.projectRoot, layout.mcpJson, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
    if (layout.id === "trae") {
      losses.push(
        loss(
          "trae.mcp.project_toggle",
          "Enable Project MCP in Trae Settings after import.",
          "warn",
          layout.mcpJson,
        ),
      );
    }
  }

  const userRules = rc.rules.filter((rule) => isUserScoped(rule));
  const userSkills = rc.skills.filter((skill) => isUserScoped(skill));
  const userMcp = rc.mcp_servers.filter((server) => isUserScoped(server));
  if (!opts.includeUser && (userRules.length || userSkills.length || userMcp.length)) {
    losses.push(
      loss(
        "user_scope.not_written",
        `Left ${userRules.length} user rule(s), ${userSkills.length} user skill(s), and ${userMcp.length} user MCP server(s) unwritten. Pass --include-user to write them under the home directory.`,
        "warn",
      ),
    );
  } else if (opts.includeUser) {
    await writeUserScope(layout, home, userRules, userSkills, userMcp, dryRun, written, changes, losses);
  }

  if (hasWorkStateContent(bundle)) {
    await put(opts.projectRoot, ".acb/WORK_STATE.md", renderWorkStateMarkdown(bundle));
    losses.push(
      loss(
        "work_state.sidecar",
        `${layout.id === "cursor" ? "Cursor" : "Trae"} has no native Work State file; wrote .acb/WORK_STATE.md for manual ingest.`,
        "info",
        ".acb/WORK_STATE.md",
      ),
    );
  }

  if (bundle.transcript) {
    if (!opts.applyTranscript) {
      losses.push(
        loss(
          "transcript.not_applied",
          "Transcript stays in the bundle. It was not written into the project and was not injected into the chat UI. Apply it with `acb transcript import --apply` or the web confirm button.",
          "warn",
        ),
      );
    } else {
      await put(opts.projectRoot, TRANSCRIPT_SIDECAR, renderTranscriptMarkdown(bundle.transcript));
      losses.push(
        loss(
          "transcript.sidecar",
          dryRun
            ? "Dry-run: would write .acb/TRANSCRIPT.md. Chat UI was not modified."
            : "Wrote a lossy transcript sidecar. Chat UI was not modified.",
          "info",
          TRANSCRIPT_SIDECAR,
        ),
      );
      losses.push(
        loss(
          "transcript.ui_not_injected",
          "Refused to inject the transcript into the agent chat store or any encrypted database.",
          "info",
        ),
      );
    }
  }

  return { written, losses, changes };
}

async function writeUserScope(
  layout: AgentLayout,
  home: string,
  rules: RuleEntry[],
  skills: SkillEntry[],
  servers: McpServerEntry[],
  dryRun: boolean,
  written: string[],
  changes: FileChange[],
  losses: LossReportEntry[],
): Promise<void> {
  const put = async (rel: string, content: string) => {
    const display = `~/${rel}`;
    const planned = await writeMapped(home, rel, content, dryRun, display);
    remember(written, changes, planned, losses, display);
  };

  if (layout.id === "cursor") {
    for (const rule of rules) {
      const split = splitRule(rule.source_path?.replace(/^user:/, ""), rule.name);
      const ext = withRuleExtension(split.ruleRel, "cursor");
      const shaped = ruleContentForTarget(rule.content, "cursor", rule);
      if (shaped.addedFrontmatter) {
        losses.push(loss("cursor.rules.frontmatter_added", "Added minimal frontmatter so Cursor will load the user rule.", "info", ext.rel));
      }
      await put(`.cursor/rules/${ext.rel}`, shaped.content);
    }
  } else {
    await writeTraeUserRules(home, rules, dryRun, written, changes, losses);
  }

  for (const skill of skills) {
    const name = safeName(skill.name);
    if (!name) {
      losses.push(loss("write.path_rejected", `Refused user skill name ${skill.name}.`, "error", skill.name));
      continue;
    }
    const root = layout.id === "cursor" ? ".cursor/skills" : ".trae/skills";
    await put(`${root}/${name}/SKILL.md`, skill.skill_md);
    if (skill.extras) {
      for (const [extraRel, body] of Object.entries(skill.extras)) {
        const safe = safeRelative(extraRel);
        if (!safe) continue;
        await put(`${root}/${name}/${safe}`, body);
      }
    }
  }

  if (servers.length === 0) return;
  if (layout.id === "trae") {
    losses.push(
      loss(
        "trae.user_mcp.unavailable",
        "Trae has no documented user MCP file. User MCP servers stayed in the bundle and were not written.",
        "warn",
      ),
    );
    return;
  }
  await mergeCursorUserMcp(home, servers, dryRun, written, changes, losses);
}

async function writeTraeUserRules(
  home: string,
  rules: RuleEntry[],
  dryRun: boolean,
  written: string[],
  changes: FileChange[],
  losses: LossReportEntry[],
): Promise<void> {
  if (rules.length === 0) return;
  const fileStyle = rules.filter((rule) => {
    const source = rule.source_path?.replace(/\\/g, "/") ?? "";
    return source === "user:.trae/user_rules" || (rule.name === "user_rules" && !source.includes("/user_rules/"));
  });
  const rest = rules.filter((rule) => !fileStyle.includes(rule));
  const dest = await resolveInside(home, ".trae/user_rules");
  let destIsFile = false;
  let destIsDir = false;
  if (dest) {
    try {
      const info = await stat(dest);
      destIsFile = info.isFile();
      destIsDir = info.isDirectory();
    } catch {
      destIsFile = false;
    }
  }
  const put = async (rel: string, content: string) => {
    const planned = await writeMapped(home, rel, content, dryRun, `~/${rel}`);
    remember(written, changes, planned, losses, `~/${rel}`);
  };
  if (rest.length === 0 && fileStyle.length === 1 && !destIsDir) {
    const rule = fileStyle[0];
    if (!rule.content.trimStart().startsWith("---")) {
      losses.push(
        loss(
          "trae.user_rules.format_unverified",
          "Copied ~/.trae/user_rules as-is. The file format varies by environment, so frontmatter was not invented.",
          "info",
          ".trae/user_rules",
        ),
      );
    }
    await put(".trae/user_rules", rule.content);
    return;
  }
  if (destIsFile && rest.length > 0) {
    losses.push(
      loss(
        "trae.user_rules.layout_conflict",
        "~/.trae/user_rules is a file, so extra user rules were not expanded into a directory.",
        "warn",
        ".trae/user_rules",
      ),
    );
    if (fileStyle[0]) {
      const shaped = ruleContentForTarget(fileStyle[0].content, "trae", fileStyle[0]);
      await put(".trae/user_rules", shaped.content);
    }
    return;
  }
  for (const rule of [...fileStyle, ...rest]) {
    const split = splitRule(rule.source_path?.replace(/^user:/, ""), rule.name === "user_rules" ? "user_rules.md" : rule.name);
    const ext = withRuleExtension(split.ruleRel, "trae");
    const shaped = ruleContentForTarget(rule.content, "trae", rule);
    await put(`.trae/user_rules/${ext.rel}`, shaped.content);
  }
}

async function mergeCursorUserMcp(
  home: string,
  servers: McpServerEntry[],
  dryRun: boolean,
  written: string[],
  changes: FileChange[],
  losses: LossReportEntry[],
): Promise<void> {
  const rel = ".cursor/mcp.json";
  const abs = await resolveInside(home, rel);
  if (!abs) {
    losses.push(loss("user_scope.symlink_skipped", "Refused to write ~/.cursor/mcp.json because it escapes the home directory.", "error", rel));
    return;
  }
  let existingText: string | undefined;
  let existing: Record<string, unknown> = {};
  try {
    existingText = await readFile(abs, "utf8");
    const parsed = JSON.parse(existingText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("mcp.json must be an object");
    existing = parsed as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      losses.push(
        loss(
          "mcp.user_invalid",
          `Refused to overwrite ~/.cursor/mcp.json: ${(err as Error).message}`,
          "error",
          rel,
        ),
      );
      return;
    }
  }
  const current =
    existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  const replaced: string[] = [];
  for (const server of servers) {
    if (server.name in current) replaced.push(server.name);
    current[server.name] = cleanConfig(server.config);
  }
  const content = `${JSON.stringify({ ...existing, mcpServers: current }, null, 2)}\n`;
  if (replaced.length > 0) {
    losses.push(
      loss(
        "mcp.user_merged",
        `Merged user MCP into ~/.cursor/mcp.json. Replaced same-named servers: ${replaced.join(", ")}. Other servers were kept.`,
        "info",
        rel,
      ),
    );
  } else {
    losses.push(loss("mcp.user_merged", "Merged user MCP into ~/.cursor/mcp.json without removing existing servers.", "info", rel));
  }
  const action: FileChange["action"] =
    existingText === undefined ? "create" : existingText === content ? "unchanged" : "update";
  if (!dryRun && action !== "unchanged") await writeText(abs, content);
  const change = { path: `~/${rel}`, action };
  changes.push(change);
  written.push(change.path);
}
