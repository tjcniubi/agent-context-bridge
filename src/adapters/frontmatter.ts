export interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  always_apply?: boolean;
  description?: string;
  globs?: string[];
  scene?: string;
  extras: { key: string; value: string }[];
  body: string;
  /** JSON array or YAML list. Trae expects a comma-separated string. */
  globsStructured: boolean;
}

export interface RuleMeta {
  always_apply?: boolean;
  description?: string;
  globs?: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function quoteIfNeeded(value: string): string {
  if (!value || /[:#\n,]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) {
    return JSON.stringify(value);
  }
  return value;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { hasFrontmatter: false, extras: [], body: content, globsStructured: false };
  }
  const lines = match[1].split(/\r?\n/);
  const extras: { key: string; value: string }[] = [];
  let always_apply: boolean | undefined;
  let description: string | undefined;
  let globs: string[] | undefined;
  let scene: string | undefined;
  let globsStructured = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const header = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!header) continue;
    const key = header[1];
    const raw = header[2].trim();
    if (key === "globs" && raw === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        i += 1;
        items.push(unquote(lines[i].replace(/^\s+-\s+/, "")));
      }
      globs = items.filter(Boolean);
      globsStructured = true;
      continue;
    }
    const value = unquote(raw);
    if (key === "alwaysApply" || key === "always_apply") {
      if (value === "true" || value === "false") always_apply = value === "true";
      continue;
    }
    if (key === "description") {
      description = value;
      continue;
    }
    if (key === "scene") {
      scene = value;
      continue;
    }
    if (key === "globs") {
      if (value.startsWith("[")) {
        globsStructured = true;
        try {
          const parsed = JSON.parse(value.replace(/'/g, '"')) as unknown;
          globs = Array.isArray(parsed) ? parsed.map((item) => String(item)) : [value];
        } catch {
          globs = [value];
        }
      } else {
        globs = value.split(",").map((item) => item.trim()).filter(Boolean);
      }
      continue;
    }
    extras.push({ key, value: raw });
  }

  return {
    hasFrontmatter: true,
    always_apply,
    description,
    globs,
    scene,
    extras,
    body: match[2] ?? "",
    globsStructured,
  };
}

export function serializeFrontmatter(
  parsed: ParsedFrontmatter,
  fallback?: RuleMeta,
): string {
  const description = parsed.description ?? fallback?.description;
  const globs = parsed.globs ?? fallback?.globs;
  const always = parsed.always_apply ?? fallback?.always_apply;
  const lines = ["---"];
  if (description) lines.push(`description: ${quoteIfNeeded(description)}`);
  if (globs && globs.length > 0) lines.push(`globs: ${globs.join(",")}`);
  if (always !== undefined) lines.push(`alwaysApply: ${always}`);
  else if (!parsed.hasFrontmatter) lines.push("alwaysApply: true");
  if (parsed.scene) lines.push(`scene: ${quoteIfNeeded(parsed.scene)}`);
  for (const extra of parsed.extras) lines.push(`${extra.key}: ${extra.value}`);
  lines.push("---", "");
  return `${lines.join("\n")}${parsed.body.replace(/^\n/, "")}`;
}

export interface ShapedRule {
  content: string;
  addedFrontmatter: boolean;
  normalizedGlobs: boolean;
  keptScene: boolean;
}

/**
 * Keep the original body when the target can read it.
 * Trae receives comma-separated globs; Cursor keeps an unrecognized `scene` key
 * so a later hop can still see it, and the caller records that loss.
 */
export function ruleContentForTarget(
  content: string,
  dialect: "cursor" | "trae",
  meta: RuleMeta,
): ShapedRule {
  const parsed = parseFrontmatter(content);
  const keptScene = Boolean(parsed.scene) && dialect === "cursor";
  if (!parsed.hasFrontmatter) {
    return {
      content: serializeFrontmatter(parsed, meta),
      addedFrontmatter: true,
      normalizedGlobs: false,
      keptScene: false,
    };
  }
  if (dialect === "trae" && parsed.globsStructured) {
    return {
      content: serializeFrontmatter(parsed, meta),
      addedFrontmatter: false,
      normalizedGlobs: true,
      keptScene: false,
    };
  }
  return { content, addedFrontmatter: false, normalizedGlobs: false, keptScene };
}

export function withRuleExtension(
  rel: string,
  dialect: "cursor" | "trae",
): { rel: string; from?: string; to?: string } {
  const norm = rel.replace(/\\/g, "/");
  if (dialect === "cursor") {
    if (norm.endsWith(".mdc")) return { rel: norm };
    if (norm.endsWith(".md")) {
      const next = `${norm.slice(0, -3)}.mdc`;
      return { rel: next, from: norm, to: next };
    }
    const next = `${norm}.mdc`;
    return { rel: next, from: norm, to: next };
  }
  if (norm.endsWith(".mdc")) {
    const next = `${norm.slice(0, -4)}.md`;
    return { rel: next, from: norm, to: next };
  }
  if (norm.endsWith(".md")) return { rel: norm };
  const next = `${norm}.md`;
  return { rel: next, from: norm, to: next };
}
