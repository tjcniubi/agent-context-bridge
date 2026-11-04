import type { AgentWorkBundle, LossReportEntry } from "../../src/protocol/types.ts";
import type { RepairSessionView } from "../../src/repair/guide.ts";

export interface AdapterInfo {
  id: string;
  displayName: string;
  project: {
    agentsMd: string;
    rulesDir: string;
    skillsDir: string;
    mcpJson: string;
    instructionNames: string[];
  };
}

export interface Summary {
  source: string;
  target: string | null;
  rules: number;
  skills: number;
  mcp: number;
  lossCount: number;
}

export interface BundleResponse {
  bundle: AgentWorkBundle;
  losses: LossReportEntry[];
  summary: Summary;
  written?: string[];
  dryRun?: boolean;
  exportLosses?: LossReportEntry[];
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let data: { error?: string; details?: string[] } = {};
  try {
    data = (await res.json()) as { error?: string; details?: string[] };
  } catch {
    data = {};
  }
  if (!res.ok) {
    const details = Array.isArray(data.details) ? data.details.filter(Boolean).join("\n") : "";
    throw new ApiError([data.error || `请求失败（${res.status}）`, details].filter(Boolean).join("\n"));
  }
  return data as T;
}

export type { AgentWorkBundle, LossReportEntry, RepairSessionView };
