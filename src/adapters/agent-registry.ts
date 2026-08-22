import { ClaudeAdapter } from "./claude/claude-adapter.js";
import { CodexAdapter } from "./codex/codex-adapter.js";
import { CodexSdkAdapter } from "./codex/sdk-adapter.js";
import { AntigravityAdapter } from "./antigravity/antigravity-adapter.js";
import type { AgentAdapter, AgentAdapterRequest, AgentRun } from "./agent-adapter.js";
import type { AdapterEngine, AgentCapabilities, AgentType } from "../common/types.js";

type AdapterKey = `${AgentType}:${AdapterEngine}`;

function key(agent: AgentType, engine: AdapterEngine): AdapterKey {
  return `${agent}:${engine}`;
}

class ClaudeCliAgentAdapter implements AgentAdapter {
  readonly id = "claude" as const;
  readonly engine = "cli" as const;
  readonly capabilities: AgentCapabilities = {
    sessions: true,
    streaming: true,
    cancellation: true,
    models: true,
    sandboxControl: false,
    fileTools: true,
    shellTools: true,
  };
  private readonly adapter = new ClaudeAdapter();

  execute(request: AgentAdapterRequest): AgentRun {
    const run = this.adapter.execute(request.prompt, {
      cwd: request.cwd,
      externalSessionId: request.externalSessionId,
      model: request.model,
      timeoutMs: request.timeoutMs,
      onOutput: request.onOutput,
    });
    return {
      process: run.process,
      promise: run.promise.then((result) => ({
        output: result.output,
        error: result.error,
        exitCode: result.exitCode,
        externalSessionId: result.detectedSessionId,
      })),
    };
  }
}

class CodexCliAgentAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly engine = "cli" as const;
  readonly capabilities: AgentCapabilities = {
    sessions: true,
    streaming: true,
    cancellation: true,
    models: false,
    sandboxControl: true,
    fileTools: true,
    shellTools: true,
  };
  private readonly adapter = new CodexAdapter();

  execute(request: AgentAdapterRequest): AgentRun {
    const run = this.adapter.execute(request.prompt, {
      cwd: request.cwd,
      externalSessionId: request.externalSessionId,
      timeoutMs: request.timeoutMs,
      onOutput: request.onOutput,
    });
    return {
      process: run.process,
      promise: run.promise.then((result) => ({
        output: result.output,
        error: result.error,
        exitCode: result.exitCode,
        externalSessionId: result.detectedThreadId,
      })),
    };
  }
}

class CodexSdkAgentAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly engine = "sdk" as const;
  readonly capabilities: AgentCapabilities = {
    sessions: true,
    streaming: true,
    cancellation: true,
    models: false,
    sandboxControl: true,
    fileTools: true,
    shellTools: true,
  };
  private readonly adapter = new CodexSdkAdapter();

  execute(request: AgentAdapterRequest): AgentRun {
    const controller = new AbortController();
    return {
      cancel: () => controller.abort(),
      promise: this.adapter.execute(request.prompt, {
        cwd: request.cwd,
        externalSessionId: request.externalSessionId,
        timeoutMs: request.timeoutMs,
        signal: controller.signal,
        onOutput: request.onOutput,
      }).then((result) => ({
        output: result.output,
        error: result.error,
        exitCode: result.exitCode,
        externalSessionId: result.detectedThreadId,
      })),
    };
  }
}

class AntigravityCliAgentAdapter implements AgentAdapter {
  readonly id = "antigravity" as const;
  readonly engine = "cli" as const;
  readonly capabilities: AgentCapabilities = {
    sessions: true,
    streaming: true,
    cancellation: true,
    models: true,
    sandboxControl: true,
    fileTools: true,
    shellTools: true,
  };
  private readonly adapter = new AntigravityAdapter();

  execute(request: AgentAdapterRequest): AgentRun {
    const run = this.adapter.execute(request.prompt, {
      cwd: request.cwd,
      externalSessionId: request.externalSessionId,
      model: request.model,
      timeoutMs: request.timeoutMs,
      onOutput: request.onOutput,
    });
    return {
      process: run.process,
      promise: run.promise.then((result) => ({
        output: result.output,
        error: result.error,
        exitCode: result.exitCode,
        externalSessionId: result.detectedSessionId,
      })),
    };
  }
}

export class AgentRegistry {
  private readonly adapters = new Map<AdapterKey, AgentAdapter>();

  constructor(adapters?: AgentAdapter[]) {
    const initial = adapters || [
      new ClaudeCliAgentAdapter(),
      new CodexCliAgentAdapter(),
      new CodexSdkAgentAdapter(),
      new AntigravityCliAgentAdapter(),
    ];
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(key(adapter.id, adapter.engine), adapter);
  }

  get(agent: AgentType, engine: AdapterEngine): AgentAdapter {
    const adapter = this.adapters.get(key(agent, engine));
    if (!adapter) {
      throw new Error(`No adapter registered for ${agent}:${engine}`);
    }
    return adapter;
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  findByCapabilities(
    requires: (keyof AgentCapabilities)[],
    preferredEngine?: AdapterEngine
  ): AgentAdapter[] {
    return this.list().filter((adapter) => {
      if (preferredEngine && adapter.engine !== preferredEngine) return false;
      return requires.every((capability) => adapter.capabilities[capability]);
    });
  }
}
