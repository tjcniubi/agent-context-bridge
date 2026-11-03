/**
 * Agent Work Bundle v0.1 — neutral intermediate format for cross-agent context.
 * See docs/protocol.md for the human-readable companion.
 */

export type AgentId = "cursor" | "trae" | "unknown" | string;

export interface LossReportEntry {
  /** Machine-readable code, e.g. "transcript.tool_results" */
  code: string;
  /** Human-readable explanation */
  message: string;
  /** How severe: info | warn | error */
  severity: "info" | "warn" | "error";
  /** Optional path or field that was dropped / approximated */
  path?: string;
}

export interface BundleManifest {
  /** Protocol version — always "0.1" for this schema */
  version: "0.1";
  source_agent: AgentId;
  target_agent?: AgentId;
  created_at: string;
  project_root?: string;
  loss_report: LossReportEntry[];
}

export interface RuleEntry {
  /** Relative path within the agent rules dir, e.g. "react-patterns.mdc" */
  name: string;
  /** Full markdown / mdc body (including frontmatter if present) */
  content: string;
  /** Optional normalized metadata extracted from frontmatter */
  always_apply?: boolean;
  description?: string;
  globs?: string[];
  /** Original relative path from project root */
  source_path?: string;
}

export interface SkillEntry {
  name: string;
  /** SKILL.md body */
  skill_md: string;
  /** Relative path of the skill directory from project root or home */
  source_path?: string;
  /** extra files under the skill dir: relpath -> content (text only in v0.1) */
  extras?: Record<string, string>;
}

export interface McpServerEntry {
  name: string;
  /** Portable subset: command/args/env or url/headers */
  config: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
  source_path?: string;
}

export interface InstructionsFile {
  /** e.g. AGENTS.md, CLAUDE.md */
  name: string;
  content: string;
  source_path?: string;
}

export interface RepoContext {
  agents_md?: string;
  rules: RuleEntry[];
  skills: SkillEntry[];
  mcp_servers: McpServerEntry[];
  instructions_files: InstructionsFile[];
}

export interface WorkStateDecision {
  summary: string;
  rationale?: string;
  decided_at?: string;
}

export interface WorkStateOpenLoop {
  summary: string;
  priority?: "low" | "medium" | "high";
  status?: "open" | "blocked" | "done";
}

export interface WorkStateFileAnchor {
  path: string;
  note?: string;
}

export interface WorkState {
  goal?: string;
  decisions: WorkStateDecision[];
  open_loops: WorkStateOpenLoop[];
  file_anchors: WorkStateFileAnchor[];
  constraints: string[];
  known_pitfalls: string[];
  last_summary?: string;
}

export interface TranscriptToolCall {
  name: string;
  arguments?: unknown;
  /** Tool results are often dropped — record in dropped_fields when missing */
  result?: unknown;
}

export interface TranscriptAttachment {
  name?: string;
  path?: string;
  mime?: string;
  /** true if binary/content was not embedded */
  omitted?: boolean;
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "tool" | string;
  content: string;
  tool_calls?: TranscriptToolCall[];
  attachments?: TranscriptAttachment[];
  dropped_fields?: string[];
  timestamp?: string;
}

export interface Transcript {
  messages: TranscriptMessage[];
  /** Session id from source agent if known */
  source_session_id?: string;
  notes?: string;
}

export interface AgentWorkBundle {
  manifest: BundleManifest;
  repo_context: RepoContext;
  work_state: WorkState;
  transcript?: Transcript;
}

export function emptyRepoContext(): RepoContext {
  return {
    rules: [],
    skills: [],
    mcp_servers: [],
    instructions_files: [],
  };
}

export function emptyWorkState(): WorkState {
  return {
    decisions: [],
    open_loops: [],
    file_anchors: [],
    constraints: [],
    known_pitfalls: [],
  };
}
