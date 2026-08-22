import { SessionStore } from "../sessions/session-store.js";
import { TaskManager } from "../tasks/task-manager.js";
import { ClaudeAdapter } from "../adapters/claude/claude-adapter.js";
import { CodexAdapter } from "../adapters/codex/codex-adapter.js";
import { CodexSdkAdapter } from "../adapters/codex/sdk-adapter.js";
import { AntigravityAdapter } from "../adapters/antigravity/antigravity-adapter.js";
import {
  AgentExecutionOptions,
  AgentSendResult,
  SessionMetadata,
  AdapterEngine,
} from "../common/types.js";
import * as path from "node:path";

export class SessionRouter {
  private sessionStore: SessionStore;
  private taskManager: TaskManager;
  private claudeCliAdapter: ClaudeAdapter;
  private codexCliAdapter: CodexAdapter;
  private codexSdkAdapter: CodexSdkAdapter;
  private antigravityAdapter: AntigravityAdapter;
  private workspaceDir: string;

  constructor(baseDir?: string, workspaceDir?: string) {
    this.workspaceDir = path.resolve(workspaceDir || process.env.AGENT_BRIDGE_WORKSPACE || process.cwd());
    this.sessionStore = new SessionStore(baseDir);
    this.taskManager = new TaskManager(baseDir);
    this.claudeCliAdapter = new ClaudeAdapter();
    this.codexCliAdapter = new CodexAdapter();
    this.codexSdkAdapter = new CodexSdkAdapter();
    this.antigravityAdapter = new AntigravityAdapter();
  }

  async init(): Promise<void> {
    await this.sessionStore.init();
    await this.taskManager.init();
  }

  resolveWorkingDirectory(options: { cwd?: string; project?: string }): string {
    const base = this.workspaceDir;
    const candidate = options.cwd
      ? path.resolve(options.cwd)
      : options.project
        ? path.resolve(base, options.project)
        : base;

    if (candidate !== base && !candidate.startsWith(base + path.sep)) {
      throw new Error(`Working directory is outside AGENT_BRIDGE_WORKSPACE: ${candidate}`);
    }

    return candidate;
  }

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  private assertSessionCompatible(
    session: SessionMetadata,
    options: AgentExecutionOptions,
    cwd: string,
    engine: AdapterEngine
  ): void {
    if (session.agent !== options.agent) {
      throw new Error(`Session ${session.id} belongs to agent '${session.agent}', not '${options.agent}'`);
    }
    if (path.resolve(session.cwd) !== cwd) {
      throw new Error(`Session ${session.id} belongs to a different working directory`);
    }
    if (options.project && session.project && session.project !== options.project) {
      throw new Error(`Session ${session.id} belongs to project '${session.project}', not '${options.project}'`);
    }
    if (session.engine && session.engine !== engine) {
      throw new Error(`Session ${session.id} uses engine '${session.engine}', not '${engine}'`);
    }
  }

  async dispatch(options: AgentExecutionOptions): Promise<AgentSendResult> {
    await this.init();
    const cwd = this.resolveWorkingDirectory({ cwd: options.cwd, project: options.project });
    const engine: AdapterEngine = options.engine || "cli";

    if (options.agent === "claude" && engine === "sdk") {
      throw new Error(
        "Claude engine='sdk' is disabled because the previous adapter used the Messages API, not Claude Code capabilities. Use engine='cli' until the Claude Agent SDK migration is implemented."
      );
    }

    let session: SessionMetadata | undefined;

    if (options.sessionId) {
      session = await this.sessionStore.getSession(options.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${options.sessionId}`);
      }
      this.assertSessionCompatible(session, options, cwd, engine);
    } else if (!options.forceNewSession) {
      session = await this.sessionStore.findMatchingSession({
        agent: options.agent,
        cwd,
        project: options.project,
        topic: options.topic,
        taskType: options.taskType,
      });
      if (session && session.engine && session.engine !== engine) {
        session = undefined;
      }
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
    } else if (options.agent === "codex") {
      if (engine === "sdk") {
        const controller = new AbortController();
        this.taskManager.registerCancellation(task.id, () => controller.abort());

        this.codexSdkAdapter
          .execute(options.prompt, {
            cwd,
            externalSessionId: session.externalSessionId,
            timeoutMs: options.timeoutMs,
            signal: controller.signal,
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
          })
          .catch(async (err) => {
            await this.taskManager.completeTask(task.id, {
              status: "failed",
              output: "",
              error: err.message,
              exitCode: -1,
            });
          });
      } else {
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
