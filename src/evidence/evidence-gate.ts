import { GitManager } from "./git.js";
import { TestRunner } from "./tests.js";
import { EvidenceReport } from "../common/types.js";

export class EvidenceGate {
  private gitManager: GitManager;
  private testRunner: TestRunner;

  constructor() {
    this.gitManager = new GitManager();
    this.testRunner = new TestRunner();
  }

  async evaluate(options: {
    cwd: string;
    testCommands?: string[];
    timeoutMs?: number;
  }): Promise<EvidenceReport> {
    const cwd = options.cwd;
    const testCommands = (options.testCommands || []).filter((command) => command.trim().length > 0);

    const git = await this.gitManager.inspect(cwd);
    const tests = await this.testRunner.runMultiple(testCommands, cwd, options.timeoutMs);

    const hasTestEvidence = testCommands.length > 0 && tests.length === testCommands.length;
    const allTestsPassed = hasTestEvidence && tests.every((t) => t.passed);
    const hasChanges = git.modifiedFiles.length > 0 || git.untrackedFiles.length > 0;

    // Fail closed: a verification gate without any verification command is not evidence.
    // A clean tree may still be valid evidence for a review-only task, so hasChanges is
    // reported but is not itself a pass requirement.
    const allPassed = git.isGitRepo && allTestsPassed;

    let summary = `Evidence Gate: ${allPassed ? "PASS" : "FAIL"}. `;
    summary += `Git: ${git.statusSummary || "clean"}. `;
    if (!hasTestEvidence) {
      summary += "Tests: no verification commands executed.";
    } else {
      summary += `Tests: ${tests.filter((t) => t.passed).length}/${tests.length} passed.`;
    }
    if (hasChanges) {
      summary += " Working tree contains changes.";
    }

    return {
      timestamp: new Date().toISOString(),
      cwd,
      git,
      tests,
      allPassed,
      summary,
    };
  }
}
