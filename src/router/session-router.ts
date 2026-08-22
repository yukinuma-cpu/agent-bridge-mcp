import { SessionStore } from "../sessions/session-store.js";
import { TaskManager } from "../tasks/task-manager.js";
import { AgentRegistry } from "../adapters/agent-registry.js";
import {
  AgentExecutionOptions,
  AgentSendResult,
  SessionMetadata,
  AdapterEngine,
  AgentCapabilities,
} from "../common/types.js";
import * as path from "node:path";

export class SessionRouter {
  private sessionStore: SessionStore;
  private taskManager: TaskManager;
  private registry: AgentRegistry;
  private workspaceDir: string;

  constructor(baseDir?: string, workspaceDir?: string, registry?: AgentRegistry) {
    this.workspaceDir = path.resolve(workspaceDir || process.env.AGENT_BRIDGE_WORKSPACE || process.cwd());
    this.sessionStore = new SessionStore(baseDir);
    this.taskManager = new TaskManager(baseDir);
    this.registry = registry || new AgentRegistry();
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

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  listAgentCapabilities() {
    return this.registry.list().map((adapter) => ({
      agent: adapter.id,
      engine: adapter.engine,
      capabilities: adapter.capabilities,
    }));
  }

  findAgentsByCapabilities(requires: (keyof AgentCapabilities)[], engine?: AdapterEngine) {
    return this.registry.findByCapabilities(requires, engine).map((adapter) => ({
      agent: adapter.id,
      engine: adapter.engine,
      capabilities: adapter.capabilities,
    }));
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
    const adapter = this.registry.get(options.agent, engine);

    let session: SessionMetadata | undefined;
    if (options.sessionId) {
      session = await this.sessionStore.getSession(options.sessionId);
      if (!session) throw new Error(`Session not found: ${options.sessionId}`);
      this.assertSessionCompatible(session, options, cwd, engine);
    } else if (!options.forceNewSession && adapter.capabilities.sessions) {
      session = await this.sessionStore.findMatchingSession({
        agent: options.agent,
        cwd,
        project: options.project,
        topic: options.topic,
        taskType: options.taskType,
        engine,
      });
    }

    if (!session) {
      session = await this.sessionStore.createSession({
        agent: options.agent,
        engine,
        cwd,
        project: options.project,
        topic: options.topic,
        taskType: options.taskType,
        summary: options.prompt.slice(0, 100),
      });
    }

    const task = await this.taskManager.createTask({
      agent: options.agent,
      engine,
      sessionId: session.id,
      externalSessionId: session.externalSessionId,
      taskType: options.taskType,
      project: options.project,
      topic: options.topic,
      prompt: options.prompt,
      cwd,
    });

    const run = adapter.execute({
      prompt: options.prompt,
      cwd,
      externalSessionId: adapter.capabilities.sessions ? session.externalSessionId : undefined,
      model: options.model,
      timeoutMs: options.timeoutMs,
      onOutput: (chunk) => this.taskManager.appendOutput(task.id, chunk),
    });

    if (run.process) {
      this.taskManager.registerProcess(task.id, run.process);
    } else if (run.cancel) {
      this.taskManager.registerCancellation(task.id, run.cancel);
    } else {
      this.taskManager.registerCancellation(task.id, () => {});
    }

    run.promise
      .then(async (res) => {
        const status = res.exitCode === 0 ? "completed" : "failed";
        await this.taskManager.completeTask(task.id, {
          status,
          output: res.output || res.error || "",
          error: res.error,
          exitCode: res.exitCode,
          externalSessionId: res.externalSessionId,
        });

        await this.sessionStore.updateSession(session!.id, {
          externalSessionId: res.externalSessionId || session!.externalSessionId,
          engine,
          summary: options.prompt.slice(0, 100),
        });
      })
      .catch(async (err) => {
        await this.taskManager.completeTask(task.id, {
          status: "failed",
          output: "",
          error: err instanceof Error ? err.message : String(err),
          exitCode: -1,
        });
      });

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
