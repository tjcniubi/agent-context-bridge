/**
 * Locate a directory the browser picked.
 * The File System Access API does not reveal an absolute path, so the local
 * server matches the folder name, child names, and an optional content hash.
 */
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { UserInputError } from "../core/errors.js";
import { isDirectory } from "../utils/fs.js";

const SKIP = new Set([
  "node_modules",
  ".git",
  "Library",
  "Caches",
  ".cache",
  ".npm",
  ".cargo",
  ".rustup",
  "dist",
  ".next",
  "coverage",
  ".venv",
  "venv",
  "AppData",
  "vendor",
  ".turbo",
  "target",
  "build",
]);

export interface LocateHint {
  name: string;
  sha256: string;
}

export interface LocateRequest {
  name: string;
  entries: string[];
  hint?: LocateHint;
  roots?: string[];
  maxDirs?: number;
  deadlineMs?: number;
  maxDepth?: number;
}

export interface LocateResult {
  matches: string[];
  truncated: boolean;
}

export async function matchProjectDirectories(request: LocateRequest): Promise<LocateResult> {
  const name = segment(request.name, "name");
  const entries = request.entries.map((entry) => segment(entry, "entries"));
  if (entries.length > 40) throw new UserInputError("entries 最多 40 个。");
  const hint = request.hint ? normalizeHint(request.hint) : undefined;
  if (entries.length === 0) return { matches: [], truncated: false };

  const roots = await resolveRoots(request.roots);
  const maxDirs = request.maxDirs ?? 40_000;
  const maxDepth = request.maxDepth ?? 8;
  const deadline = Date.now() + (request.deadlineMs ?? 7000);
  const queue: { path: string; depth: number }[] = roots.map((path) => ({ path, depth: 0 }));
  const seen = new Set<string>();
  const matches: string[] = [];
  let visited = 0;
  let truncated = false;

  while (queue.length > 0 && matches.length < 8) {
    if (Date.now() > deadline || visited >= maxDirs) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (!current || seen.has(current.path)) continue;
    seen.add(current.path);
    let dirents;
    try {
      dirents = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    visited += 1;
    const names = dirents.map((entry) => entry.name);
    if (basename(current.path) === name && entries.every((entry) => names.includes(entry))) {
      matches.push(current.path);
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of dirents) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  if (hint && matches.length > 1) {
    const hashed: string[] = [];
    for (const match of matches) {
      const digest = await hashPrefix(join(match, hint.name));
      if (digest === hint.sha256) hashed.push(match);
    }
    if (hashed.length > 0) return { matches: hashed, truncated };
  }
  return { matches, truncated };
}

export function defaultLocateRoots(): string[] {
  return [...new Set([homedir(), dirname(process.cwd()), process.cwd()].map((root) => resolve(root)))];
}

async function resolveRoots(roots: string[] | undefined): Promise<string[]> {
  const requested = roots && roots.length > 0 ? roots.slice(0, 5) : defaultLocateRoots();
  const resolved: string[] = [];
  for (const root of requested) {
    if (typeof root !== "string" || !root.trim()) throw new UserInputError("roots 里有空路径。");
    const full = resolve(root);
    if (!(await isDirectory(full))) throw new UserInputError(`不是目录：${full}`);
    resolved.push(full);
  }
  return [...new Set(resolved)];
}

function normalizeHint(hint: LocateHint): LocateHint {
  return {
    name: segment(hint.name, "hint.name"),
    sha256: sha(hint.sha256),
  };
}

function segment(value: string, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed.length > 200 || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new UserInputError(`${label} 必须是单个路径片段。`);
  }
  if (trimmed === "." || trimmed === "..") throw new UserInputError(`${label} 不能是 . 或 ..。`);
  return trimmed;
}

function sha(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(trimmed)) throw new UserInputError("hint.sha256 必须是 64 位十六进制。");
  return trimmed;
}

async function hashPrefix(file: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, 65536, 0);
    if (bytesRead <= 0) return undefined;
    return createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
