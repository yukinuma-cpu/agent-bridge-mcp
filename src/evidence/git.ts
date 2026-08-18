import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitEvidence } from "../common/types.js";

const execFileAsync = promisify(execFile);

export class GitManager {
  async inspect(cwd: string): Promise<GitEvidence> {
    try {
      // 1. Check if git repo and get branch + head commit
      const { stdout: headInfo } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        timeout: 10000,
      });
      const branch = headInfo.trim();

      const { stdout: commitInfo } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd,
        timeout: 10000,
      }).catch(() => ({ stdout: "uncommitted" }));
      const commitHash = commitInfo.trim();

      // 2. Get git status --porcelain
      const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd,
        timeout: 10000,
      });

      const modifiedFiles: string[] = [];
      const untrackedFiles: string[] = [];

      const lines = statusOut.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const code = line.slice(0, 2).trim();
        const file = line.slice(3).trim();
        if (code === "??") {
          untrackedFiles.push(file);
        } else {
          modifiedFiles.push(file);
        }
      }

      // 3. Get diff summary and stat
      const { stdout: diffStat } = await execFileAsync("git", ["diff", "--stat", "HEAD"], {
        cwd,
        timeout: 10000,
      }).catch(() => ({ stdout: "" }));

      const { stdout: diffSummary } = await execFileAsync("git", ["diff", "--unified=3"], {
        cwd,
        timeout: 15000,
      }).catch(() => ({ stdout: "" }));

      return {
        isGitRepo: true,
        branch,
        commitHash,
        statusSummary: `${modifiedFiles.length} modified, ${untrackedFiles.length} untracked files`,
        modifiedFiles,
        untrackedFiles,
        diffStat: diffStat.trim(),
        diffSummary: diffSummary.length > 5000 ? `${diffSummary.slice(0, 5000)}\n...[truncated]` : diffSummary,
      };
    } catch {
      return {
        isGitRepo: false,
        modifiedFiles: [],
        untrackedFiles: [],
        statusSummary: "Not a git repository or git command unavailable",
      };
    }
  }

  async commitAndPush(cwd: string, message: string): Promise<{ success: boolean; output: string; error?: string }> {
    try {
      await execFileAsync("git", ["add", "."], { cwd, timeout: 15000 });
      const { stdout: commitOut } = await execFileAsync("git", ["commit", "-m", message || "feat: AI verified implementation by Agent Bridge"], { cwd, timeout: 20000 });
      const { stdout: pushOut } = await execFileAsync("git", ["push"], { cwd, timeout: 30000 }).catch((err) => ({ stdout: `Push notice: ${err.message}` }));

      return {
        success: true,
        output: `${commitOut}\n${pushOut}`.trim(),
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: err.message,
      };
    }
  }
}
