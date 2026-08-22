import Anthropic from "@anthropic-ai/sdk";
import * as crypto from "node:crypto";

export interface ClaudeSdkExecutionResult {
  output: string;
  error?: string;
  exitCode: number | null;
  detectedSessionId?: string;
}

export class ClaudeSdkAdapter {
  private client: Anthropic;
  private conversationHistory: Map<string, Array<{ role: "user" | "assistant"; content: string }>> = new Map();

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || "dummy-key-for-init",
    });
  }

  async execute(
    prompt: string,
    options: {
      cwd: string;
      externalSessionId?: string;
      model?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
    }
  ): Promise<ClaudeSdkExecutionResult> {
    const sessionId = options.externalSessionId || crypto.randomUUID();
    const history = this.conversationHistory.get(sessionId) || [];
    history.push({ role: "user", content: prompt });

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
      const model = options.model || "claude-3-7-sonnet-20250219";
      let outputText = "";

      if (options.onOutput) {
        const stream = await this.client.messages.stream(
          {
            model,
            max_tokens: 4096,
            messages: history,
          },
          { signal: controller.signal }
        );

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const text = event.delta.text;
            outputText += text;
            options.onOutput(text);
          }
        }
      } else {
        const response = await this.client.messages.create(
          {
            model,
            max_tokens: 4096,
            messages: history,
          },
          { signal: controller.signal }
        );

        const firstBlock = response.content[0];
        if (firstBlock && firstBlock.type === "text") {
          outputText = firstBlock.text;
        }
      }

      history.push({ role: "assistant", content: outputText });
      this.conversationHistory.set(sessionId, history);

      return {
        output: outputText.trim(),
        exitCode: 0,
        detectedSessionId: sessionId,
      };
    } catch (err: any) {
      const aborted = controller.signal.aborted;
      return {
        output: "",
        error: timedOut
          ? `Claude SDK execution timed out after ${options.timeoutMs}ms`
          : aborted
            ? "Claude SDK execution cancelled"
            : `Claude SDK error: ${err.message}`,
        exitCode: aborted ? -1 : 1,
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
