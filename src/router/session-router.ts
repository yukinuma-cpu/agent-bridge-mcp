import { SessionStore } from "../sessions/session-store.js";
import { TaskManager } from "../tasks/task-manager.js";
import { ClaudeAdapter } from "../adapters/claude/claude-adapter.js";
import { CodexAdapter } from "../adapters/codex/codex-adapter.js";
import { CodexSdkAdapter } from "../adapters/codex/sdk-adapter.js";
import { ClaudeSdkAdapter } from "../adapters/claude/sdk-adapter.js";
import { AntigravityAdapter } from "../adapters/antigravity/antigravity-adapter.js";
import { EvidenceGate } from "../evidence/evidence-gate.js";
import {
  AgentExecutionOptions,
  AgentSendResult,
  SessionMetadata,
  AdapterEngine,
} from "../common/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export class SessionRouter {
  private sessionStore: SessionStore;
  private taskManager: TaskManager;
  private claudeCliAdapter: ClaudeAdapter;
  private codexCliAdapter: CodexAdapter;
  private codexSdkAdapter: CodexSdkAdapter;
  private claudeSdkAdapter: ClaudeSdkAdapter;
  private antigravityAdapter: AntigravityAdapter;
  private evidenceGate: EvidenceGate;
  private workspaceDir: string;

  constructor(baseDir?: string, workspaceDir?: string) {
    this.workspaceDir = workspaceDir || process.env.AGENT_BRIDGE_WORKSPACE || process.cwd();
    this.sessionStore = new SessionStore(baseDir);
    this.taskManager = new TaskManager(baseDir);
    this.claudeCliAdapter = new ClaudeAdapter();
    this.codexCliAdapter = new CodexAdapter();
    this.codexSdkAdapter = new CodexSdkAdapter();
    this.claudeSdkAdapter = new ClaudeSdkAdapter();
    this.antigravityAdapter = new AntigravityAdapter();
    this.evidenceGate = new EvidenceGate();
  }

  async init(): Promise<void> {
    await this.sessionStore.init();
    await this.taskManager.init();
  }

  async dispatch(options: AgentExecutionOptions): Promise<AgentSendResult> {
    await this.init();
    const cwd = options.cwd || process.cwd();
    const engine: AdapterEngine = options.engine || "cli";

    // 1. Resolve Session
    let session: SessionMetadata | undefined;

    if (options.sessionId) {
      session = await this.sessionStore.getSession(options.sessionId);
    } else if (!options.forceNewSession) {
      session = await this.sessionStore.findMatchingSession({
        agent: options.agent,
        cwd,
        project: options.project,
        topic: options.topic,
        taskType: options.taskType,
      });
    }

    if (!session) {
      session = await this.sessionStore.createSession({
        agent: options.agent,
        cwd,
        project: options.project,
        topic: options.topic,
        taskType: options.taskType,
        summary: options.prompt.slice(0, 100),
      });
    }

    // 2. Create Task Record
    const task = await this.taskManager.createTask({
      agent: options.agent,
      sessionId: session.id,
      externalSessionId: session.externalSessionId,
      taskType: options.taskType,
      project: options.project,
      topic: options.topic,
      prompt: options.prompt,
      cwd,
    });

    // 3. Dispatch to appropriate Engine & Adapter
    if (options.agent === "antigravity") {
      const { process: child, promise } = this.antigravityAdapter.execute(options.prompt, {
        cwd,
        model: options.model,
        timeoutMs: options.timeoutMs,
        onOutput: (chunk) => this.taskManager.appendOutput(task.id, chunk),
      });

      this.taskManager.registerProcess(task.id, child);

      promise
        .then(async (res) => {
          const status = res.exitCode === 0 ? "completed" : "failed";
          await this.taskManager.completeTask(task.id, {
            status,
            output: res.output || res.error || "",
            error: res.error,
            exitCode: res.exitCode,
          });

          if (session) {
            await this.sessionStore.updateSession(session.id, {
              engine: "cli",
              summary: options.prompt.slice(0, 100),
            });
          }
        })
        .catch(async (err) => {
          await this.taskManager.completeTask(task.id, {
            status: "failed",
            output: "",
            error: err.message,
            exitCode: -1,
          });
        });
    } else if (options.agent === "claude") {
      if (engine === "sdk") {
        // SDK Execution
        this.claudeSdkAdapter
          .execute(options.prompt, {
            cwd,
            externalSessionId: session.externalSessionId,
            model: options.model,
            timeoutMs: options.timeoutMs,
            onOutput: (chunk) => this.taskManager.appendOutput(task.id, chunk),
          })
          .then(async (res) => {
            const status = res.exitCode === 0 ? "completed" : "failed";
            await this.taskManager.completeTask(task.id, {
              status,
              output: res.output || res.error || "",
              error: res.error,
              exitCode: res.exitCode,
              externalSessionId: res.detectedSessionId,
            });

            if (res.detectedSessionId && session) {
              await this.sessionStore.updateSession(session.id, {
                externalSessionId: res.detectedSessionId,
                engine: "sdk",
                summary: options.prompt.slice(0, 100),
              });
            }
          });
      } else {
        // CLI Execution
        const { process: child, promise } = this.claudeCliAdapter.execute(
          options.prompt,
          {
            cwd,
            externalSessionId: session.externalSessionId,
            model: options.model,
            timeoutMs: options.timeoutMs,
            onOutput: (chunk) => this.taskManager.appendOutput(task.id, chunk),
          }
        );

        this.taskManager.registerProcess(task.id, child);

        promise
          .then(async (res) => {
            const status = res.exitCode === 0 ? "completed" : "failed";
            await this.taskManager.completeTask(task.id, {
              status,
              output: res.output || res.error || "",
              error: res.error,
              exitCode: res.exitCode,
              externalSessionId: res.detectedSessionId,
            });

            if (res.detectedSessionId && session) {
              await this.sessionStore.updateSession(session.id, {
                externalSessionId: res.detectedSessionId,
                engine: "cli",
                summary: options.prompt.slice(0, 100),
              });
            }
          })
          .catch(async (err) => {
            await this.taskManager.completeTask(task.id, {
              status: "failed",
              output: "",
              error: err.message,
              exitCode: -1,
            });
          });
      }
    } else if (options.agent === "codex") {
      if (engine === "sdk") {
        // SDK Execution
        this.codexSdkAdapter
          .execute(options.prompt, {
            cwd,
            externalSessionId: session.externalSessionId,
            timeoutMs: options.timeoutMs,
            onOutput: (chunk) => this.taskManager.appendOutput(task.id, chunk),
          })
          .then(async (res) => {
            const status = res.exitCode === 0 ? "completed" : "failed";
            await this.taskManager.completeTask(task.id, {
              status,
              output: res.output || res.error || "",
              error: res.error,
              exitCode: res.exitCode,
              externalSessionId: res.detectedThreadId,
            });

            if (res.detectedThreadId && session) {
              await this.sessionStore.updateSession(session.id, {
                externalSessionId: res.detectedThreadId,
                engine: "sdk",
                summary: options.prompt.slice(0, 100),
              });
            }
          });
      } else {
        // CLI Execution
        const { process: child, promise } = this.codexCliAdapter.execute(
          options.prompt,
          {
            cwd,
            externalSessionId: session.externalSessionId,
            timeoutMs: options.timeoutMs,
            onOutput: (chunk) => this.taskManager.appendOutput(task.id, chunk),
          }
        );

        this.taskManager.registerProcess(task.id, child);

        promise
          .then(async (res) => {
            const status = res.exitCode === 0 ? "completed" : "failed";
            await this.taskManager.completeTask(task.id, {
              status,
              output: res.output || res.error || "",
              error: res.error,
              exitCode: res.exitCode,
              externalSessionId: res.detectedThreadId,
            });

            if (res.detectedThreadId && session) {
              await this.sessionStore.updateSession(session.id, {
                externalSessionId: res.detectedThreadId,
                engine: "cli",
                summary: options.prompt.slice(0, 100),
              });
            }
          })
          .catch(async (err) => {
            await this.taskManager.completeTask(task.id, {
              status: "failed",
              output: "",
              error: err.message,
              exitCode: -1,
            });
          });
      }
    }

    return {
      taskId: task.id,
      sessionId: session.id,
      agent: options.agent,
      engine,
      status: "running",
      message: `Task ${task.id} dispatched to ${options.agent} [${engine}] (session: ${session.id})`,
    };
  }

  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  getSessionStore(): SessionStore {
    return this.sessionStore;
  }
}
