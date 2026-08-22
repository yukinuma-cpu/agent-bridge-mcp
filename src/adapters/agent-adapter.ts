import type { ChildProcess } from "node:child_process";
import type { AdapterEngine, AgentCapabilities, AgentType } from "../common/types.js";

export interface AgentAdapterRequest {
  prompt: string;
  cwd: string;
  externalSessionId?: string;
  model?: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface AgentAdapterResult {
  output: string;
  error?: string;
  exitCode: number | null;
  externalSessionId?: string;
}

export interface AgentRun {
  promise: Promise<AgentAdapterResult>;
  process?: ChildProcess;
  cancel?: () => void;
}

export interface AgentAdapter {
  readonly id: AgentType;
  readonly engine: AdapterEngine;
  readonly capabilities: AgentCapabilities;
  execute(request: AgentAdapterRequest): AgentRun;
}
