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

function parseReviewVerdict(output: string): ReviewVerdict {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";

  if (/^PASS\b/.test(firstLine)) return "PASS";
  if (/^ESCALATE\b/.test(firstLine)) return "ESCALATE";
  return "REVISE";
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

    while (iteration <= maxRevisions) {
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

      let implTask = await this.router.getTaskManager().getTask(implSend.taskId);
      while (implTask && (implTask.status === "running" || implTask.status === "queued")) {
        await sleep(1000);
        implTask = await this.router.getTaskManager().getTask(implSend.taskId);
      }

      const evidence = await this.evidenceGate.evaluate({
        cwd: options.cwd,
        testCommands: options.testCommands,
        timeoutMs: 60000,
      });

      const reviewPrompt = `
You are a senior code reviewer.
Original Task:
${options.prompt}

Implementation Task Status:
${implTask?.status || "missing"}

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
2. The first non-empty line MUST be exactly one verdict token followed optionally by a short reason: PASS, REVISE, or ESCALATE.
3. Use PASS only when the implementation is correct and the Evidence Gate passed.
4. Use REVISE for bugs, incomplete work, failed/missing evidence, or failed implementation tasks, followed by actionable instructions for ${implementer}.
5. Use ESCALATE only when the task is impossible, contradictory, or requires a human business decision.
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

      let reviewTask = await this.router.getTaskManager().getTask(reviewSend.taskId);
      while (reviewTask && (reviewTask.status === "running" || reviewTask.status === "queued")) {
        await sleep(1000);
        reviewTask = await this.router.getTaskManager().getTask(reviewSend.taskId);
      }

      const reviewOutput = reviewTask?.output || "";
      let verdict = parseReviewVerdict(reviewOutput);

      // PASS is valid only when every non-LLM gate also succeeded. A reviewer cannot
      // override missing/failed evidence or a failed implementation task by wording.
      if (
        verdict === "PASS" &&
        (implTask?.status !== "completed" || reviewTask?.status !== "completed" || !evidence.allPassed)
      ) {
        verdict = "REVISE";
      }

      // A failed reviewer task never counts as a semantic verdict.
      if (reviewTask?.status !== "completed" && verdict !== "ESCALATE") {
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

      if (verdict === "PASS") {
        return {
          status: "PASSED",
          totalRevisions: iteration,
          maxRevisionsReached: false,
          iterations,
          finalVerdict: "PASS",
          summary: `Task completed successfully with passing evidence and reviewer approval in iteration ${iteration}.`,
        };
      }

      if (verdict === "ESCALATE") {
        return {
          status: "ESCALATED",
          totalRevisions: iteration,
          maxRevisionsReached: false,
          iterations,
          finalVerdict: "ESCALATE",
          summary: `Task escalated by reviewer in iteration ${iteration}: ${reviewOutput.slice(0, 200)}`,
        };
      }

      iteration++;
      if (iteration <= maxRevisions) {
        currentPrompt = `
Reviewer requested revisions:
${reviewOutput || "Reviewer did not return a valid PASS/ESCALATE verdict."}

Evidence status:
${evidence.summary}

Please fix the issues and ensure the configured verification commands pass.
`.trim();
      }
    }

    return {
      status: "REVISION_REQUIRED",
      totalRevisions: maxRevisions,
      maxRevisionsReached: true,
      iterations,
      finalVerdict: "REVISE",
      summary: `Max revisions limit (${maxRevisions}) reached without a verified PASS. Escalating to Antigravity/User.`,
    };
  }
}
