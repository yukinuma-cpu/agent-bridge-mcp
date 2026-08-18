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
      onOutput?: (chunk: string) => void;
    }
  ): Promise<ClaudeSdkExecutionResult> {
    const sessionId = options.externalSessionId || crypto.randomUUID();
    const history = this.conversationHistory.get(sessionId) || [];

    history.push({ role: "user", content: prompt });

    try {
      const model = options.model || "claude-3-7-sonnet-20250219";
      let outputText = "";

      if (options.onOutput) {
        const stream = await this.client.messages.stream({
          model,
          max_tokens: 4096,
          messages: history,
        });

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const text = event.delta.text;
            outputText += text;
            options.onOutput(text);
          }
        }
      } else {
        const response = await this.client.messages.create({
          model,
          max_tokens: 4096,
          messages: history,
        });

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
      return {
        output: "",
        error: `Claude SDK error: ${err.message}`,
        exitCode: 1,
      };
    }
  }
}
