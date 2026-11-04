import type { AgentWorkBundle, LossReportEntry } from "../protocol/types.js";

export interface AdapterPaths {
  /** Project-relative paths this adapter reads/writes */
  project: {
    agentsMd: string;
    rulesDir: string;
    skillsDir: string;
    mcpJson: string;
    /** Extra instruction files at project root */
    instructionNames: string[];
  };
  /** User-home relative paths (documented; optional in MVP) */
  user?: {
    mcpJson?: string;
    skillsDir?: string;
    rulesDir?: string;
  };
}

export interface FileChange {
  /** Project-relative path, or `~/...` for user-home writes */
  path: string;
  action: "create" | "update" | "unchanged";
}

export interface ExportOptions {
  projectRoot: string;
  /** Include user-global configs when true (default false) */
  includeUser?: boolean;
  /** Session id, or a path to a plaintext transcript export */
  sessionId?: string;
  /** Read a lossy transcript when true. `--session` implies this. */
  includeTranscript?: boolean;
  transcriptMaxBytes?: number;
  transcriptMaxMessages?: number;
  /**
   * Home directory used for user-scope files and Cursor transcripts.
   * Defaults to os.homedir(). Tests pass a temp directory.
   */
  userHome?: string;
  /**
   * When false, a session path outside the project is refused.
   * CLI defaults to true; the local web API sets false.
   */
  allowExternalTranscriptFile?: boolean;
}

export interface ImportOptions {
  projectRoot: string;
  /** Dry-run: do not write files */
  dryRun?: boolean;
  /** Write user-scoped bundle entries under the home directory */
  includeUser?: boolean;
  /** Write `.acb/TRANSCRIPT.md`. Never injects a chat UI or encrypted DB. */
  applyTranscript?: boolean;
  userHome?: string;
}

export interface AgentAdapter {
  id: string;
  displayName: string;
  paths: AdapterPaths;
  exportRepoContext(opts: ExportOptions): Promise<{
    bundle: AgentWorkBundle;
    losses: LossReportEntry[];
  }>;
  importRepoContext(
    bundle: AgentWorkBundle,
    opts: ImportOptions,
  ): Promise<{ written: string[]; losses: LossReportEntry[]; changes: FileChange[] }>;
}
