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

export interface ExportOptions {
  projectRoot: string;
  /** Include user-global configs when true (default false for project-first MVP) */
  includeUser?: boolean;
  /** Layer 3: optional session id for transcript export (stub) */
  sessionId?: string;
}

export interface ImportOptions {
  projectRoot: string;
  /** Dry-run: do not write files */
  dryRun?: boolean;
  includeUser?: boolean;
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
  ): Promise<{ written: string[]; losses: LossReportEntry[] }>;
}
