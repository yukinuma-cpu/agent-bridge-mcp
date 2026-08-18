export type AgentType = "claude" | "codex" | "antigravity";

export type AdapterEngine = "cli" | "sdk";

export type TaskType =
  | "architecture"
  | "implementation"
  | "review"
  | "adversarial_review"
  | "investigation"
  | "refactor"
  | "test"
  | "orchestration"
  | "general";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface SessionMetadata {
  id: string; // Internal bridge session ID
  agent: AgentType;
  externalSessionId?: string; // Claude session ID, Codex thread ID, or Agy conversation ID
  engine?: AdapterEngine;
  project?: string;
  topic?: string;
  taskType?: TaskType;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  status: "active" | "archived";
}

export interface TaskRecord {
  id: string;
  agent: AgentType;
  sessionId: string;
  externalSessionId?: string;
  engine?: AdapterEngine;
  taskType: TaskType;
  project?: string;
  topic?: string;
  prompt: string;
  cwd: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  output: string;
  error?: string;
}

export interface AgentExecutionOptions {
  agent: AgentType;
  prompt: string;
  cwd?: string;
  sessionId?: string; // Explicit internal session ID if known
  project?: string;
  topic?: string;
  taskType?: TaskType;
  model?: string;
  engine?: AdapterEngine; // "cli" (default) or "sdk"
  forceNewSession?: boolean;
  timeoutMs?: number;
}

export interface AgentSendResult {
  taskId: string;
  sessionId: string;
  agent: AgentType;
  engine: AdapterEngine;
  status: TaskStatus;
  message: string;
}

export interface AgentStatusResult {
  taskId: string;
  sessionId: string;
  agent: AgentType;
  engine?: AdapterEngine;
  status: TaskStatus;
  createdAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  exitCode?: number | null;
}

// Phase 6: Evidence Gate Types
export interface GitEvidence {
  isGitRepo: boolean;
  branch?: string;
  commitHash?: string;
  statusSummary?: string;
  modifiedFiles: string[];
  untrackedFiles: string[];
  diffStat?: string;
  diffSummary?: string;
}

export interface TestEvidence {
  command: string;
  passed: boolean;
  exitCode: number | null;
  output: string;
  error?: string;
  durationMs: number;
}

export interface EvidenceReport {
  timestamp: string;
  cwd: string;
  git: GitEvidence;
  tests: TestEvidence[];
  allPassed: boolean;
  summary: string;
}

// Phase 5: Automated Review Loop Types
export type ReviewVerdict = "PASS" | "REVISE" | "ESCALATE";

export interface ReviewLoopIteration {
  iteration: number;
  implementationTaskId: string;
  evidence: EvidenceReport;
  reviewTaskId: string;
  verdict: ReviewVerdict;
  feedback: string;
}

export interface ReviewLoopResult {
  status: "PASSED" | "REVISION_REQUIRED" | "ESCALATED" | "FAILED";
  totalRevisions: number;
  maxRevisionsReached: boolean;
  iterations: ReviewLoopIteration[];
  finalVerdict: ReviewVerdict;
  summary: string;
}
