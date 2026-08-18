import { spawn, ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";

export interface ClaudeExecutionResult {
  output: string;
  error?: string;
  exitCode: number | null;
  detectedSessionId?: string;
}

export class ClaudeAdapter {
  execute(
    prompt: string,
    options: {
      cwd: string;
      externalSessionId?: string;
      model?: string;
      timeoutMs?: number;
      onOutput?: (chunk: string) => void;
    }
  ): {
    process: ChildProcess;
    promise: Promise<ClaudeExecutionResult>;
  } {
    let targetSessionId = options.externalSessionId;
    const model = options.model || "sonnet";
    const args: string[] = ["--model", model, "-p", prompt];

    const isValidUuid = (id?: string) =>
      !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

    if (isValidUuid(targetSessionId)) {
      args.push("--resume", targetSessionId!);
    } else {
      // Assign deterministic UUID for new session
      targetSessionId = crypto.randomUUID();
      args.push("--session-id", targetSessionId);
    }

    const child = spawn("claude", args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Close stdin immediately
    child.stdin?.end();

    const promise = new Promise<ClaudeExecutionResult>((resolve) => {
      let stdoutData = "";
      let stderrData = "";
      let isResolved = false;

      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            child.kill();
            resolve({
              output: stdoutData,
              error: `Execution timed out after ${options.timeoutMs}ms. Stderr: ${stderrData}`,
              exitCode: -1,
            });
          }
        }, options.timeoutMs);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutData += text;
        if (options.onOutput) options.onOutput(text);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrData += text;
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (!isResolved) {
          isResolved = true;
          resolve({
            output: stdoutData.trim(),
            error: stderrData.trim() || undefined,
            exitCode: code,
            detectedSessionId: targetSessionId,
          });
        }
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        if (!isResolved) {
          isResolved = true;
          resolve({
            output: stdoutData,
            error: `Process error: ${err.message}. Stderr: ${stderrData}`,
            exitCode: -1,
          });
        }
      });
    });

    return { process: child, promise };
  }
}
