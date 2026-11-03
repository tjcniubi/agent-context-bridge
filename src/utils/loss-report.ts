import type { LossReportEntry } from "../protocol/types.js";

export function loss(
  code: string,
  message: string,
  severity: LossReportEntry["severity"] = "warn",
  path?: string,
): LossReportEntry {
  return { code, message, severity, ...(path ? { path } : {}) };
}

export function formatLossReport(entries: LossReportEntry[]): string {
  if (entries.length === 0) return "(no losses reported)";
  return entries
    .map((e) => `[${e.severity}] ${e.code}: ${e.message}${e.path ? ` (${e.path})` : ""}`)
    .join("\n");
}
