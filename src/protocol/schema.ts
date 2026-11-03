/**
 * Zod runtime schema for Agent Work Bundle v0.1.
 * Kept in sync with schemas/agent-work-bundle.v0.1.schema.json.
 */
import { z } from "zod";

export const LossReportEntrySchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(["info", "warn", "error"]),
  path: z.string().optional(),
});

export const BundleManifestSchema = z.object({
  version: z.literal("0.1"),
  source_agent: z.string().min(1),
  target_agent: z.string().optional(),
  created_at: z.string().min(1),
  project_root: z.string().optional(),
  loss_report: z.array(LossReportEntrySchema),
});

export const RuleEntrySchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  always_apply: z.boolean().optional(),
  description: z.string().optional(),
  globs: z.array(z.string()).optional(),
  source_path: z.string().optional(),
});

export const SkillEntrySchema = z.object({
  name: z.string().min(1),
  skill_md: z.string(),
  source_path: z.string().optional(),
  extras: z.record(z.string()).optional(),
});

export const McpServerEntrySchema = z.object({
  name: z.string().min(1),
  config: z
    .object({
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string()).optional(),
    })
    .passthrough(),
  source_path: z.string().optional(),
});

export const InstructionsFileSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  source_path: z.string().optional(),
});

export const RepoContextSchema = z.object({
  agents_md: z.string().optional(),
  rules: z.array(RuleEntrySchema),
  skills: z.array(SkillEntrySchema),
  mcp_servers: z.array(McpServerEntrySchema),
  instructions_files: z.array(InstructionsFileSchema),
});

export const WorkStateDecisionSchema = z.object({
  summary: z.string().min(1),
  rationale: z.string().optional(),
  decided_at: z.string().optional(),
});

export const WorkStateOpenLoopSchema = z.object({
  summary: z.string().min(1),
  priority: z.enum(["low", "medium", "high"]).optional(),
  status: z.enum(["open", "blocked", "done"]).optional(),
});

export const WorkStateFileAnchorSchema = z.object({
  path: z.string().min(1),
  note: z.string().optional(),
});

export const WorkStateSchema = z.object({
  goal: z.string().optional(),
  decisions: z.array(WorkStateDecisionSchema),
  open_loops: z.array(WorkStateOpenLoopSchema),
  file_anchors: z.array(WorkStateFileAnchorSchema),
  constraints: z.array(z.string()),
  known_pitfalls: z.array(z.string()),
  last_summary: z.string().optional(),
});

export const TranscriptToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
});

export const TranscriptAttachmentSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  mime: z.string().optional(),
  omitted: z.boolean().optional(),
});

export const TranscriptMessageSchema = z.object({
  role: z.string().min(1),
  content: z.string(),
  tool_calls: z.array(TranscriptToolCallSchema).optional(),
  attachments: z.array(TranscriptAttachmentSchema).optional(),
  dropped_fields: z.array(z.string()).optional(),
  timestamp: z.string().optional(),
});

export const TranscriptSchema = z.object({
  messages: z.array(TranscriptMessageSchema),
  source_session_id: z.string().optional(),
  notes: z.string().optional(),
});

export const AgentWorkBundleSchema = z.object({
  manifest: BundleManifestSchema,
  repo_context: RepoContextSchema,
  work_state: WorkStateSchema,
  transcript: TranscriptSchema.optional(),
});

export type AgentWorkBundleParsed = z.infer<typeof AgentWorkBundleSchema>;
