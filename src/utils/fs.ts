import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
  stat,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  return readFile(path, "utf8");
}

export async function readJsonIfExists<T = unknown>(
  path: string,
): Promise<T | undefined> {
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

/** Recursively list files under dir with given extensions (no leading dot required). */
export async function listFilesRecursive(
  dir: string,
  extensions?: string[],
): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listFilesRecursive(full, extensions)));
    } else if (ent.isFile()) {
      if (!extensions || extensions.some((ext) => ent.name.endsWith(ext))) {
        out.push(full);
      }
    }
  }
  return out;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export { join, relative, dirname };
