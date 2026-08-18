import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface CodexExecutionResult {
  output: string;
  error?: string;
  exitCode: number | null;
  detectedThreadId?: string;
}

export class CodexAdapter {
  private resolveCodexCommand(): { executable: string; baseArgs: string[] } {
    if (process.platform === "win32") {
      const appData = process.env.APPDATA || "";
      const nodeModulesCodex = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(nodeModulesCodex)) {
        return {
          executable: process.execPath || "node",
          baseArgs: [nodeModulesCodex],
        };
      }
      return {
        executable: process.env.ComSpec || "cmd.exe",
        baseArgs: ["/d", "/c", "codex"],
      };
    }
    return {
      executable: "codex",
      baseArgs: [],
    };
  }

  execute(
    prompt: string,
    options: {
      cwd: string;
      externalSessionId?: string; // thread ID
      timeoutMs?: number;
      bypassApprovals?: boolean;
      onOutput?: (chunk: string) => void;
    }
  ): {
    process: ChildProcess;
    promise: Promise<CodexExecutionResult>;
  } {
    const { executable, baseArgs } = this.resolveCodexCommand();
    const args: string[] = [...baseArgs, "exec", "--skip-git-repo-check"];

    // In automated background bridge mode, bypass approval prompts so it won't hang waiting for interactive input
    if (options.bypassApprovals !== false) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }

    if (options.externalSessionId && /^[a-zA-Z0-9_-]+$/.test(options.externalSessionId)) {
      args.push("resume", options.externalSessionId, prompt);
    } else {
      args.push(prompt);
    }

    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Close stdin immediately so codex does not wait for stdin
    child.stdin?.end();

    const promise = new Promise<CodexExecutionResult>((resolve) => {
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
          // Look for session id / thread ID in stdout or stderr
          const allLogs = `${stdoutData}\n${stderrData}`;
          const sessionMatch = allLogs.match(/session\s+id:\s*([0-9a-f-]{36})/i) ||
                               allLogs.match(/\b(thr_[a-zA-Z0-9]+)\b/);
          const detectedThreadId = sessionMatch ? sessionMatch[1] : undefined;

          resolve({
            output: stdoutData.trim(),
            error: stderrData.trim() || undefined,
            exitCode: code,
            detectedThreadId,
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
