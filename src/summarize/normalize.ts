/**
 * Coerce untrusted Work State JSON into the v0.1 shape.
 * Shared by the web apply endpoint and the optional model draft parser.
 */
import { UserInputError } from "../core/errors.js";
import { WorkStateSchema } from "../protocol/schema.js";
import type { LossReportEntry, WorkState } from "../protocol/types.js";

export function normalizeWorkState(input: unknown): WorkState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new UserInputError("workState 必须是对象。");
  }
  const record = input as Record<string, unknown>;
  const goal = cleanOptional(record.goal);
  const last = cleanOptional(record.last_summary);
  const decisions = asArray(record.decisions)
    .map((item) => {
      const row = asObject(item);
      const summary = cleanOptional(row?.summary);
      if (!summary) return undefined;
      const rationale = cleanOptional(row?.rationale);
      const decidedAt = cleanOptional(row?.decided_at);
      return {
        summary,
        ...(rationale ? { rationale } : {}),
        ...(decidedAt ? { decided_at: decidedAt } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 30);
  const openLoops = asArray(record.open_loops)
    .map((item) => {
      const row = asObject(item);
      const summary = cleanOptional(row?.summary);
      if (!summary) return undefined;
      const priority = cleanOptional(row?.priority);
      const status = cleanOptional(row?.status);
      return {
        summary,
        ...(priority === "low" || priority === "medium" || priority === "high" ? { priority } : {}),
        ...(status === "open" || status === "blocked" || status === "done" ? { status } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 30);
  const anchors = asArray(record.file_anchors)
    .map((item) => {
      const row = asObject(item);
      const path = cleanOptional(row?.path);
      if (!path) return undefined;
      const note = cleanOptional(row?.note);
      return { path, ...(note ? { note } : {}) };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 30);
  const constraints = asArray(record.constraints)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 30);
  const pitfalls = asArray(record.known_pitfalls)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 30);
  const parsed = WorkStateSchema.safeParse({
    ...(goal ? { goal } : {}),
    ...(last ? { last_summary: last } : {}),
    decisions,
    open_loops: openLoops,
    file_anchors: anchors,
    constraints,
    known_pitfalls: pitfalls,
  });
  if (!parsed.success) {
    throw new UserInputError(
      "Work State 无法通过校验:",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export function normalizeLosses(input: unknown): LossReportEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new UserInputError("losses 必须是数组。");
  const losses: LossReportEntry[] = [];
  for (const item of input.slice(0, 80)) {
    const row = asObject(item);
    if (!row) continue;
    const code = cleanOptional(row.code);
    const message = cleanOptional(row.message);
    const severity = row.severity;
    if (!code || !message) continue;
    if (severity !== "info" && severity !== "warn" && severity !== "error") continue;
    const path = cleanOptional(row.path);
    losses.push({
      code: code.slice(0, 120),
      message: message.slice(0, 2000),
      severity,
      ...(path ? { path: path.slice(0, 500) } : {}),
    });
  }
  return losses;
}

function cleanOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 8000) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
