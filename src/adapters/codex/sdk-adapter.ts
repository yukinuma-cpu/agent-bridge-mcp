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
      externalSessionId?: string; // Thread ID
      timeoutMs?: number;
      onOutput?: (chunk: string) => void;
    }
  ): Promise<CodexSdkExecutionResult> {
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
        const streamedTurn = await thread.runStreamed(prompt);
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
        const turn = await thread.run(prompt);
        resultText = turn.finalResponse;
      }

      const threadId = thread.id || undefined;

      return {
        output: resultText.trim(),
        exitCode: 0,
        detectedThreadId: threadId,
      };
    } catch (err: any) {
      return {
        output: "",
        error: `Codex SDK error: ${err.message}`,
        exitCode: 1,
      };
    }
  }
}
