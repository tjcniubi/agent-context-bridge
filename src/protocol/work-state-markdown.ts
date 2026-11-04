/**
 * Markdown companion for Work State.
 * Import adapters and the local web sidecar writer share this renderer.
 */
import type { AgentWorkBundle } from "./types.js";

export function hasWorkStateContent(bundle: AgentWorkBundle): boolean {
  const ws = bundle.work_state;
  return Boolean(
    ws.goal ||
      ws.last_summary ||
      ws.decisions.length ||
      ws.open_loops.length ||
      ws.file_anchors.length ||
      ws.constraints.length ||
      ws.known_pitfalls.length,
  );
}

export function renderWorkStateMarkdown(bundle: AgentWorkBundle): string {
  const ws = bundle.work_state;
  const lines: string[] = ["# Agent Work State", ""];
  if (ws.goal) {
    lines.push("## Goal", "", ws.goal, "");
  }
  if (ws.last_summary) {
    lines.push("## Summary", "", ws.last_summary, "");
  }
  if (ws.decisions.length) {
    lines.push("## Decisions", "");
    for (const d of ws.decisions) {
      lines.push(`- ${d.summary}${d.rationale ? ` — ${d.rationale}` : ""}`);
    }
    lines.push("");
  }
  if (ws.open_loops.length) {
    lines.push("## Open loops", "");
    for (const o of ws.open_loops) {
      lines.push(
        `- [${o.status ?? "open"}] ${o.summary}${o.priority ? ` (${o.priority})` : ""}`,
      );
    }
    lines.push("");
  }
  if (ws.file_anchors.length) {
    lines.push("## File anchors", "");
    for (const f of ws.file_anchors) {
      lines.push(`- \`${f.path}\`${f.note ? `: ${f.note}` : ""}`);
    }
    lines.push("");
  }
  if (ws.constraints.length) {
    lines.push("## Constraints", "");
    for (const c of ws.constraints) lines.push(`- ${c}`);
    lines.push("");
  }
  if (ws.known_pitfalls.length) {
    lines.push("## Known pitfalls", "");
    for (const p of ws.known_pitfalls) lines.push(`- ${p}`);
    lines.push("");
  }
  return lines.join("\n");
}
