import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Project- or home-relative path with no absolute prefix and no `..`. */
export function safeRelative(rel: string): string | undefined {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return undefined;
  const parts = norm.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

export function safeName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed || /[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") return undefined;
  return trimmed;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve `root/rel` without following a symlink that escapes `root`.
 * Missing tail segments are allowed so callers can create files.
 * Returns undefined when the path is unsafe.
 */
export async function resolveInside(root: string, rel: string): Promise<string | undefined> {
  const safe = safeRelative(rel);
  if (!safe) return undefined;
  const rootAbs = resolve(root);
  let realRoot: string;
  try {
    realRoot = await realpath(rootAbs);
  } catch {
    realRoot = rootAbs;
  }

  const parts = safe.split("/");
  let current = realRoot;
  for (let i = 0; i < parts.length; i++) {
    const next = join(current, parts[i]);
    let linked = false;
    try {
      const st = await lstat(next);
      if (st.isSymbolicLink()) {
        linked = true;
        let real: string;
        try {
          real = await realpath(next);
        } catch {
          return undefined;
        }
        if (!isInside(realRoot, real)) return undefined;
        current = real;
      } else if (i < parts.length - 1 && !st.isDirectory()) {
        return undefined;
      } else {
        current = next;
      }
    } catch {
      return join(current, ...parts.slice(i));
    }
    if (linked && i === parts.length - 1) return current;
  }
  return current;
}
