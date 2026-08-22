import { spawn, ChildProcess, execFile } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface AntigravityExecutionResult {
  output: string;
  error?: string;
  exitCode: number | null;
  detectedSessionId?: string;
}

interface AgyJsonEnvelope {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
}

export class AntigravityAdapter {
  private resolveWinpty(): string | null {
    const candidates = [
      process.env.WINPTY_PATH,
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "winpty.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "usr", "bin", "winpty.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "usr", "bin", "winpty.exe"),
    ].filter((p): p is string => Boolean(p));

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private resolveAgy(): string {
    if (process.env.AGY_PATH && fs.existsSync(process.env.AGY_PATH)) {
      return process.env.AGY_PATH;
    }
    if (process.platform === "win32") {
      const local = path.join(process.env.LOCALAPPDATA || "", "agy", "bin", "agy.exe");
      if (fs.existsSync(local)) return local;
      return "agy.exe";
    }
    return "agy";
  }

  private cleanOutput(raw: string): string {
    return raw
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1B\][^\x07]*\x07/g, "")
      .replace(/\r/g, "")
      .split("\n")
      .filter((line) => !AntigravityAdapter.WINPTY_NOISE.test(line.trim()))
      .join("\n");
  }

  private static readonly WINPTY_NOISE = /Assertion failed|libwinpty|winpty\.cc|cols > 0 && rows > 0/;

  private parseJsonEnvelope(raw: string): AgyJsonEnvelope | undefined {
    const lines = this.cleanOutput(raw)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && ("status" in parsed || "conversation_id" in parsed)) {
          return parsed as AgyJsonEnvelope;
        }
      } catch {
        // winpty may add non-JSON terminal noise around the final envelope.
      }
    }
    return undefined;
  }

  private reap(child: ChildProcess): void {
    if (process.platform !== "win32" || child.pid === undefined) {
      child.kill("SIGKILL");
      return;
    }
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {
      /* ignore already-exited process errors */
    });
  }

  execute(
    prompt: string,
    options: {
      cwd: string;
      externalSessionId?: string;
      timeoutMs?: number;
      model?: string;
      bypassPermissions?: boolean;
      onOutput?: (chunk: string) => void;
    }
  ): {
    process: ChildProcess;
    promise: Promise<AntigravityExecutionResult>;
  } {
    const agy = this.resolveAgy();
    const agyArgs = ["-p", prompt, "--output-format", "json"];

    if (options.externalSessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(options.externalSessionId)) {
        throw new Error("Invalid Antigravity conversation ID");
      }
      agyArgs.push("--conversation", options.externalSessionId);
    }
    if (options.bypassPermissions !== false) {
      agyArgs.push("--dangerously-skip-permissions");
    }
    if (options.model) agyArgs.push("--model", options.model);

    let executable: string;
    let args: string[];

    const winpty = process.platform === "win32" ? this.resolveWinpty() : null;
    if (winpty) {
      executable = winpty;
      args = ["-Xplain", "-Xallow-non-tty", agy, ...agyArgs];
    } else {
      executable = agy;
      args = agyArgs;
    }

    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const promise = new Promise<AntigravityExecutionResult>((resolve) => {
      let stdoutData = "";
      let stderrData = "";
      let isResolved = false;
      let timedOut = false;

      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!isResolved) {
            timedOut = true;
            this.reap(child);
          }
        }, options.timeoutMs);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutData += chunk.toString();
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrData += this.cleanOutput(chunk.toString());
      });

      const finish = (result: AntigravityExecutionResult) => {
        if (isResolved) return;
        isResolved = true;
        if (timer) clearTimeout(timer);
        child.stdin?.end();
        resolve(result);
      };

      child.on("close", (code) => {
        if (timedOut) {
          finish({
            output: "",
            error: `Execution timed out after ${options.timeoutMs}ms. Stderr: ${stderrData.trim()}`,
            exitCode: -1,
          });
          return;
        }

        const envelope = this.parseJsonEnvelope(stdoutData);
        if (!envelope) {
          const fallback = this.cleanOutput(stdoutData).trim();
          finish({
            output: fallback,
            error: fallback ? stderrData.trim() || undefined : `agy produced no parseable JSON output. Stderr: ${stderrData.trim() || "(empty)"}`,
            exitCode: fallback && code === 0 ? 0 : code === 0 ? 1 : code,
          });
          return;
        }

        const response = envelope.response?.trim() || "";
        if (response && options.onOutput) options.onOutput(response);
        const succeeded = envelope.status === "SUCCESS";

        finish({
          output: response,
          error: succeeded ? undefined : envelope.error || stderrData.trim() || `agy status: ${envelope.status || "unknown"}`,
          exitCode: succeeded ? 0 : code === 0 ? 1 : code,
          detectedSessionId: envelope.conversation_id || undefined,
        });
      });

      child.on("error", (err) => {
        this.reap(child);
        finish({
          output: "",
          error: `Failed to launch ${executable}: ${err.message}`,
          exitCode: -1,
        });
      });
    });

    return { process: child, promise };
  }
}
