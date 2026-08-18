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
    const testCommands = options.testCommands || [];

    const git = await this.gitManager.inspect(cwd);
    const tests = await this.testRunner.runMultiple(testCommands, cwd, options.timeoutMs);

    const allTestsPassed = tests.every((t) => t.passed);
    const hasChanges = git.modifiedFiles.length > 0 || git.untrackedFiles.length > 0;

    const allPassed = allTestsPassed && (testCommands.length === 0 || tests.length > 0);

    let summary = `Evidence Gate: ${allPassed ? "PASS" : "FAIL"}. `;
    summary += `Git: ${git.statusSummary || "clean"}. `;
    if (tests.length > 0) {
      summary += `Tests: ${tests.filter((t) => t.passed).length}/${tests.length} passed.`;
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
