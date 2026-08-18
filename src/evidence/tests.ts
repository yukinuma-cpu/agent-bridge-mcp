import { exec } from "node:child_process";
import { TestEvidence } from "../common/types.js";

export class TestRunner {
  async runCommand(command: string, cwd: string, timeoutMs = 60000): Promise<TestEvidence> {
    const startTime = Date.now();

    return new Promise<TestEvidence>((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startTime;
          const passed = !error || error.code === 0;

          resolve({
            command,
            passed,
            exitCode: error ? (error.code ?? -1) : 0,
            output: stdout.trim(),
            error: stderr.trim() || undefined,
            durationMs,
          });
        }
      );
    });
  }

  async runMultiple(commands: string[], cwd: string, timeoutMs = 60000): Promise<TestEvidence[]> {
    const results: TestEvidence[] = [];
    for (const cmd of commands) {
      const result = await this.runCommand(cmd, cwd, timeoutMs);
      results.push(result);
    }
    return results;
  }
}
