import { spawn, ChildProcess, execFile } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface AntigravityExecutionResult {
  output: string;
  error?: string;
  exitCode: number | null;
}

/**
 * Antigravity (`agy`) CLI adapter.
 *
 * `agy` starts an internal language server and expects to be attached to a terminal.
 * Launched from a plain pipe it shuts down before answering; launched with no stdin
 * at all it exits immediately. Both look like a hang from the caller's side.
 *
 * So on Windows we run it under `winpty`, which hands it a pseudo terminal, and we
 * deliberately leave our end of stdin open for the lifetime of the call.
 */
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

  /**
   * winpty は色制御と、自身が cols/rows=0 で落ちるときの assertion をノイズとして混ぜてくる。
   * assertion は複数行に割れて届くので、先頭行だけでなく継続行も落とす。
   */
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

  /** timeout で打ち切った agy はゾンビ化しうるので、プロセスツリーごと落とす。 */
  private reap(child: ChildProcess): void {
    if (process.platform !== "win32" || child.pid === undefined) {
      child.kill("SIGKILL");
      return;
    }
    // プロセスツリー指定で落とす。`/IM agy.exe` だと利用者が別に開いている
    // 対話中の agy まで巻き込むので使わない。
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {
      /* 既に終了している場合のエラーは無視してよい */
    });
  }

  execute(
    prompt: string,
    options: {
      cwd: string;
      timeoutMs?: number;
      model?: string;
      onOutput?: (chunk: string) => void;
    }
  ): {
    process: ChildProcess;
    promise: Promise<AntigravityExecutionResult>;
  } {
    const agy = this.resolveAgy();
    const agyArgs = ["-p", prompt, "--dangerously-skip-permissions"];
    if (options.model) agyArgs.push("--model", options.model);

    let executable: string;
    let args: string[];

    const winpty = process.platform === "win32" ? this.resolveWinpty() : null;
    const viaWinpty = Boolean(winpty);
    if (winpty) {
      // -Xplain      色制御を抑止する
      // -Xallow-non-tty  呼び出し側が端末でなくても pty を作らせる
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

    // stdin は閉じない。閉じると agy が応答前に落ちる。
    // （シェルでの `< <(sleep N)` に相当する部分をここで担保している）

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
        const text = this.cleanOutput(chunk.toString());
        stdoutData += text;
        if (text && options.onOutput) options.onOutput(text);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrData += this.cleanOutput(chunk.toString());
      });

      const finish = (exitCode: number | null, errorMessage?: string) => {
        if (isResolved) return;
        isResolved = true;
        if (timer) clearTimeout(timer);
        child.stdin?.end();
        resolve({
          output: stdoutData.trim(),
          error: errorMessage || stderrData.trim() || undefined,
          exitCode,
        });
      };

      child.on("close", (code) => {
        if (timedOut) {
          finish(-1, `Execution timed out after ${options.timeoutMs}ms. Stderr: ${stderrData.trim()}`);
          return;
        }
        if (!stdoutData.trim()) {
          finish(code === 0 ? 1 : code, `agy produced no output. Stderr: ${stderrData.trim() || "(empty)"}`);
          return;
        }
        // winpty は自身の assertion で abort するため、agy の終了コードをそのまま返さない
        // （応答が正常でも 3 などになる）。pty 経由のときは終了コードを信用せず、
        // 応答が得られたかどうかで成否を判定する。
        finish(viaWinpty ? 0 : code);
      });

      child.on("error", (err) => {
        this.reap(child);
        finish(-1, `Failed to launch ${executable}: ${err.message}`);
      });
    });

    return { process: child, promise };
  }
}
