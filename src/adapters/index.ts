import type { AgentAdapter } from "./types.js";
import { cursorAdapter } from "./cursor.js";
import { traeAdapter } from "./trae.js";

const adapters: Record<string, AgentAdapter> = {
  cursor: cursorAdapter,
  trae: traeAdapter,
};

export function getAdapter(id: string): AgentAdapter {
  const a = adapters[id.toLowerCase()];
  if (!a) {
    throw new Error(
      `Unknown agent "${id}". Supported: ${Object.keys(adapters).join(", ")}`,
    );
  }
  return a;
}

export function listAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}

export type { AgentAdapter } from "./types.js";
export { cursorAdapter, traeAdapter };
