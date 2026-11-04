import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "out",
  ".turbo",
  ".cache",
  ".acb",
]);

export interface WalkedFile {
  abs: string;
  rel: string;
}

export async function walkProject(
  root: string,
  limits: { maxFiles?: number; maxDepth?: number } = {},
): Promise<{ files: WalkedFile[]; truncated: boolean; unreadable: string[] }> {
  const maxFiles = limits.maxFiles ?? 8000;
  const maxDepth = limits.maxDepth ?? 14;
  const files: WalkedFile[] = [];
  const unreadable: string[] = [];
  let truncated = false;

  async function rec(dir: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      const rel = relative(root, dir).replace(/\\/g, "/");
      unreadable.push(rel || ".");
      return;
    }
    for (const ent of entries) {
      if (truncated) return;
      if (ent.isSymbolicLink()) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (depth >= maxDepth) {
          truncated = true;
          return;
        }
        await rec(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      files.push({ abs, rel: relative(root, abs).replace(/\\/g, "/") });
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  }

  await rec(root, 0);
  return { files, truncated, unreadable };
}
