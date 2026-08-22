import { Codex } from "@openai/codex-sdk";

export interface CodexSdkExecutionResult {
  output: string;
  error?: string;
  exitCode: number | null;
  detectedThreadId?: string;
}

export class CodexSdkAdapter {
  private codex: Codex;

  constructor() {
    this.codex = new Codex();
  }

  async execute(
    prompt: string,
    options: {
      cwd: string;
      externalSessionId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
    }
  ): Promise<CodexSdkExecutionResult> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) controller.abort();

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
    }

    try {
      const threadOptions = {
        workingDirectory: options.cwd,
        skipGitRepoCheck: true,
        approvalPolicy: "never" as const,
        sandboxMode: "danger-full-access" as const,
      };

      const thread = options.externalSessionId
        ? this.codex.resumeThread(options.externalSessionId, threadOptions)
        : this.codex.startThread(threadOptions);

      let resultText = "";

      if (options.onOutput) {
        const streamedTurn = await thread.runStreamed(prompt, { signal: controller.signal });
        for await (const event of streamedTurn.events) {
          if (event.type === "item.updated" || event.type === "item.completed") {
            if (event.item.type === "agent_message") {
              const text = event.item.text;
              resultText = text;
              options.onOutput(text);
            }
          }
        }
      } else {
        const turn = await thread.run(prompt, { signal: controller.signal });
        resultText = turn.finalResponse;
      }

      return {
        output: resultText.trim(),
        exitCode: 0,
        detectedThreadId: thread.id || undefined,
      };
    } catch (err: any) {
      const aborted = controller.signal.aborted;
      return {
        output: "",
        error: timedOut
          ? `Codex SDK execution timed out after ${options.timeoutMs}ms`
          : aborted
            ? "Codex SDK execution cancelled"
            : `Codex SDK error: ${err.message}`,
        exitCode: aborted ? -1 : 1,
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
