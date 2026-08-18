import { SessionRouter } from "../router/session-router.js";
import { EvidenceGate } from "../evidence/evidence-gate.js";
import {
  ReviewLoopResult,
  ReviewLoopIteration,
  ReviewVerdict,
  AdapterEngine,
} from "../common/types.js";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ReviewLoopOrchestrator {
  private router: SessionRouter;
  private evidenceGate: EvidenceGate;

  constructor(router: SessionRouter) {
    this.router = router;
    this.evidenceGate = new EvidenceGate();
  }

  async run(options: {
    prompt: string;
    cwd: string;
    project?: string;
    topic?: string;
    implementer?: string;
    reviewer?: string;
    testCommands?: string[];
    maxRevisions?: number;
    engine?: AdapterEngine;
    timeoutMs?: number;
  }): Promise<ReviewLoopResult> {
    const maxRevisions = options.maxRevisions ?? 2;
    const project = options.project || "default-project";
    const topic = options.topic || `task-${Date.now()}`;
    const implementer = options.implementer || "codex";
    const reviewer = options.reviewer || "claude";
    const engine = options.engine || "cli";
    const timeoutMs = options.timeoutMs || 180000;

    const iterations: ReviewLoopIteration[] = [];
    let currentPrompt = options.prompt;
    let iteration = 0;
    let finalVerdict: ReviewVerdict = "REVISE";

    while (iteration <= maxRevisions) {
      // 1. Dispatch Implementation Task to Implementer Agent
      const implSend = await this.router.dispatch({
        agent: implementer as any,
        prompt: currentPrompt,
        cwd: options.cwd,
        project,
        topic,
        taskType: iteration === 0 ? "implementation" : "refactor",
        engine,
        timeoutMs,
      });

      // Wait for Codex implementation to complete
      let implTask = await this.router.getTaskManager().getTask(implSend.taskId);
      while (implTask && (implTask.status === "running" || implTask.status === "queued")) {
        await sleep(1000);
        implTask = await this.router.getTaskManager().getTask(implSend.taskId);
      }

      // 2. Evaluate Evidence Gate (Git diff + Automated Tests)
      const evidence = await this.evidenceGate.evaluate({
        cwd: options.cwd,
        testCommands: options.testCommands,
        timeoutMs: 60000,
      });

      // 3. Dispatch Review Task to Claude (Reviewer Independence: separate task_type/session)
      const reviewPrompt = `
You are a senior code reviewer.
Original Task:
${options.prompt}

Implementation Output:
${implTask?.output || "(No text output)"}

Evidence Gate Summary:
${evidence.summary}

Git Diff:
\`\`\`diff
${evidence.git.diffSummary || "(No git diff)"}
\`\`\`

Test Results:
${evidence.tests.map((t) => `- [${t.passed ? "PASS" : "FAIL"}] \`${t.command}\`: ${t.output || t.error || ""}`).join("\n") || "(No automated tests executed)"}

Instructions:
1. Review the changes thoroughly.
2. If the implementation is correct and all tests pass, start your response with "PASS" followed by a summary.
3. If there are issues, bugs, or failing tests, start your response with "REVISE" followed by specific, actionable instructions for ${implementer}.
4. If the task is impossible, contradictory, or requires human business decision, start with "ESCALATE".
`.trim();

      const reviewSend = await this.router.dispatch({
        agent: reviewer as any,
        prompt: reviewPrompt,
        cwd: options.cwd,
        project,
        topic: `${topic}-review`,
        taskType: "review",
        engine,
        timeoutMs,
      });

      // Wait for reviewer review to complete
      let reviewTask = await this.router.getTaskManager().getTask(reviewSend.taskId);
      while (reviewTask && (reviewTask.status === "running" || reviewTask.status === "queued")) {
        await sleep(1000);
        reviewTask = await this.router.getTaskManager().getTask(reviewSend.taskId);
      }

      const reviewOutput = reviewTask?.output || "";
      let verdict: ReviewVerdict = "REVISE";

      if (reviewOutput.startsWith("PASS") || reviewOutput.includes("PASS")) {
        verdict = "PASS";
      } else if (reviewOutput.startsWith("ESCALATE") || reviewOutput.includes("ESCALATE")) {
        verdict = "ESCALATE";
      } else {
        verdict = "REVISE";
      }

      iterations.push({
        iteration,
        implementationTaskId: implSend.taskId,
        evidence,
        reviewTaskId: reviewSend.taskId,
        verdict,
        feedback: reviewOutput,
      });

      finalVerdict = verdict;

      if (verdict === "PASS") {
        return {
          status: "PASSED",
          totalRevisions: iteration,
          maxRevisionsReached: false,
          iterations,
          finalVerdict: "PASS",
          summary: `Task completed successfully and approved by Claude in iteration ${iteration}.`,
        };
      }

      if (verdict === "ESCALATE") {
        return {
          status: "ESCALATED",
          totalRevisions: iteration,
          maxRevisionsReached: false,
          iterations,
          finalVerdict: "ESCALATE",
          summary: `Task escalated by Claude in iteration ${iteration}: ${reviewOutput.slice(0, 200)}`,
        };
      }

      // If REVISE, prepare next prompt for Codex
      iteration++;
      if (iteration <= maxRevisions) {
        currentPrompt = `
Reviewer Claude requested revisions:
${reviewOutput}

Please fix the issues identified by the reviewer and ensure all tests pass.
`.trim();
      }
    }

    return {
      status: "REVISION_REQUIRED",
      totalRevisions: maxRevisions,
      maxRevisionsReached: true,
      iterations,
      finalVerdict: "REVISE",
      summary: `Max revisions limit (${maxRevisions}) reached without full PASS. Escalating to Antigravity/User.`,
    };
  }
}
