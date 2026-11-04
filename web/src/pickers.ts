export interface DirectoryFingerprint {
  name: string;
  entries: string[];
  hint?: { name: string; sha256: string };
}

interface DirectoryHandleLike {
  name: string;
  entries(): AsyncIterable<[string, { kind: string }]>;
  getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>;
}

interface FileHandleLike {
  getFile(): Promise<File>;
}

const HINT_NAMES = ["package.json", "AGENTS.md", "README.md"];

export async function tryNativeDirectory(): Promise<DirectoryFingerprint | "fallback" | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandleLike>;
    }
  ).showDirectoryPicker;
  if (typeof picker !== "function") return "fallback";
  try {
    const dir = await picker({ mode: "read" });
    return await fingerprintFromHandle(dir);
  } catch (err) {
    if (isAbort(err)) return null;
    return "fallback";
  }
}

export async function tryNativeTextFile(): Promise<File | "fallback" | null> {
  const openPicker = (
    window as unknown as {
      showOpenFilePicker?: (opts: {
        multiple?: boolean;
        types?: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<FileHandleLike[]>;
    }
  ).showOpenFilePicker;
  if (typeof openPicker !== "function") return "fallback";
  try {
    const [handle] = await openPicker({
      multiple: false,
      types: [
        {
          description: "Notes or transcript",
          accept: {
            "application/json": [".json", ".jsonl"],
            "text/plain": [".txt", ".md", ".jsonl"],
            "text/markdown": [".md"],
          },
        },
      ],
    });
    if (!handle) return null;
    return await handle.getFile();
  } catch (err) {
    if (isAbort(err)) return null;
    return "fallback";
  }
}

export async function tryNativeBundleFile(): Promise<File | "fallback" | null> {
  const openPicker = (
    window as unknown as {
      showOpenFilePicker?: (opts: {
        multiple?: boolean;
        types?: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<FileHandleLike[]>;
    }
  ).showOpenFilePicker;
  if (typeof openPicker !== "function") return "fallback";
  try {
    const [handle] = await openPicker({
      multiple: false,
      types: [{ description: "Agent Work Bundle", accept: { "application/json": [".json"] } }],
    });
    if (!handle) return null;
    return await handle.getFile();
  } catch (err) {
    if (isAbort(err)) return null;
    return "fallback";
  }
}

export function armFileInput(input: HTMLInputElement, onFiles: (files: File[]) => void): void {
  const onChange = () => {
    input.removeEventListener("change", onChange);
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length > 0) onFiles(files);
  };
  input.addEventListener("change", onChange);
  input.click();
}

export async function fingerprintFromFiles(files: File[]): Promise<DirectoryFingerprint | null> {
  if (files.length === 0) return null;
  const paths = files.map((file) => file.webkitRelativePath || file.name);
  const name = paths[0]?.split(/[/\\]/)[0];
  if (!name || name.includes("..")) return null;
  const entries = new Set<string>();
  for (const rel of paths) {
    const parts = rel.split(/[/\\]/);
    const child = parts[1];
    if (child && !child.includes("..")) entries.add(child);
    if (entries.size >= 40) break;
  }
  const hint = await hintFromFiles(name, files);
  return { name, entries: [...entries], ...(hint ? { hint } : {}) };
}

async function fingerprintFromHandle(dir: DirectoryHandleLike): Promise<DirectoryFingerprint> {
  const entries: string[] = [];
  for await (const [name] of dir.entries()) {
    if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") continue;
    entries.push(name);
    if (entries.length >= 40) break;
  }
  let hint: DirectoryFingerprint["hint"];
  for (const name of HINT_NAMES) {
    if (!entries.includes(name)) continue;
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      if (file.size === 0) continue;
      hint = { name, sha256: await sha256Prefix(file) };
      break;
    } catch {
      // unreadable child
    }
  }
  return { name: dir.name, entries, ...(hint ? { hint } : {}) };
}

async function hintFromFiles(dirName: string, files: File[]): Promise<DirectoryFingerprint["hint"]> {
  for (const name of HINT_NAMES) {
    const file = files.find((item) => {
      const rel = item.webkitRelativePath || item.name;
      return rel === `${dirName}/${name}` || rel === `${dirName}\\${name}`;
    });
    if (!file || file.size === 0) continue;
    try {
      return { name, sha256: await sha256Prefix(file) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function sha256Prefix(file: File): Promise<string> {
  const subtle = crypto.subtle;
  if (!subtle) throw new Error("缺少 crypto.subtle");
  const digest = await subtle.digest("SHA-256", await file.slice(0, 65536).arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
