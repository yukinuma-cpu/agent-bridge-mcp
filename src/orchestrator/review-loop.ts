import { SessionRouter } from "../router/session-router.js";
import { WorkflowEngine } from "./workflow-engine.js";
import {
  ReviewLoopResult,
  ReviewLoopIteration,
  ReviewVerdict,
  AdapterEngine,
  AgentType,
  EvidenceReport,
} from "../common/types.js";

export function parseReviewVerdict(output: string): ReviewVerdict {
  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  if (/^PASS\b/.test(firstLine)) return "PASS";
  if (/^ESCALATE\b/.test(firstLine)) return "ESCALATE";
  return "REVISE";
}

export class ReviewLoopOrchestrator {
  private readonly workflow: WorkflowEngine;

  constructor(router: SessionRouter) {
    this.workflow = new WorkflowEngine(router);
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
    const implementer = (options.implementer || "codex") as AgentType;
    const reviewer = (options.reviewer || "claude") as AgentType;
    const engine = options.engine || "cli";
    const timeoutMs = options.timeoutMs || 180000;

    const iterations: ReviewLoopIteration[] = [];
    let currentPrompt = options.prompt;
    let iteration = 0;

    while (iteration <= maxRevisions) {
      const implementationRun = await this.workflow.run({
        workflow: {
          steps: [{
            type: "agent",
            role: "implementer",
            agent: implementer,
            engine,
            taskType: iteration === 0 ? "implementation" : "refactor",
            prompt: "{{input}}",
          }],
        },
        input: currentPrompt,
        cwd: options.cwd,
        project,
        topic: `${topic}:iteration:${iteration}:implementation`,
        timeoutMs,
      });
      const implTask = implementationRun.steps[0]?.task;

      const evidenceRun = await this.workflow.run({
        workflow: {
          steps: [{ type: "evidence", role: "verifier", testCommands: options.testCommands || [] }],
        },
        input: options.prompt,
        cwd: options.cwd,
        project,
        topic: `${topic}:iteration:${iteration}:evidence`,
        timeoutMs: 60000,
      });
      const evidence = evidenceRun.steps[0]?.evidence as EvidenceReport;

      const reviewInput = `Original Task:\n${options.prompt}\n\nImplementation Task Status:\n${implTask?.status || "missing"}\n\nImplementation Output:\n${implTask?.output || "(No text output)"}\n\nEvidence Gate Summary:\n${evidence?.summary || "(No evidence)"}\n\nGit Diff:\n${evidence?.git.diffSummary || "(No git diff)"}\n\nTest Results:\n${evidence?.tests.map((t) => `- [${t.passed ? "PASS" : "FAIL"}] ${t.command}: ${t.output || t.error || ""}`).join("\n") || "(No automated tests executed)"}\n\nInstructions:\n1. Review the changes thoroughly.\n2. The first non-empty line MUST start with PASS, REVISE, or ESCALATE.\n3. PASS is allowed only when implementation and evidence are both successful.\n4. REVISE must contain actionable feedback.\n5. ESCALATE only for impossible, contradictory, or human-decision tasks.`;

      const reviewRun = await this.workflow.run({
        workflow: {
          steps: [{
            type: "agent",
            role: "reviewer",
            agent: reviewer,
            engine,
            taskType: "review",
            prompt: "{{input}}",
          }],
        },
        input: reviewInput,
        cwd: options.cwd,
        project,
        topic: `${topic}:iteration:${iteration}:review`,
        timeoutMs,
      });
      const reviewTask = reviewRun.steps[0]?.task;
      const reviewOutput = reviewTask?.output || "";
      let verdict = parseReviewVerdict(reviewOutput);

      if (
        verdict === "PASS" &&
        (implTask?.status !== "completed" || reviewTask?.status !== "completed" || !evidence?.allPassed)
      ) {
        verdict = "REVISE";
      }
      if (reviewTask?.status !== "completed" && verdict !== "ESCALATE") {
        verdict = "REVISE";
      }

      iterations.push({
        iteration,
        implementationTaskId: implTask?.id || "missing",
        evidence,
        reviewTaskId: reviewTask?.id || "missing",
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
        currentPrompt = `Reviewer requested revisions:\n${reviewOutput || "Reviewer did not return a valid verdict."}\n\nEvidence status:\n${evidence?.summary || "No evidence available"}\n\nPlease fix the issues and ensure the configured verification commands pass.`;
      }
    }

    return {
      status: "REVISION_REQUIRED",
      totalRevisions: maxRevisions,
      maxRevisionsReached: true,
      iterations,
      finalVerdict: "REVISE",
      summary: `Max revisions limit (${maxRevisions}) reached without a verified PASS.`,
    };
  }
}
