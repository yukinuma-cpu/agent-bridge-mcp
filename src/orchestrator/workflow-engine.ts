import { SessionRouter } from "../router/session-router.js";
import { EvidenceGate } from "../evidence/evidence-gate.js";
import type {
  AdapterEngine,
  AgentCapabilities,
  AgentType,
  EvidenceReport,
  TaskRecord,
  WorkflowDefinition,
  WorkflowAgentStep,
} from "../common/types.js";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkflowExecutionStep {
  index: number;
  role: string;
  type: "agent" | "evidence";
  agent?: AgentType;
  engine?: AdapterEngine;
  task?: TaskRecord;
  evidence?: EvidenceReport;
  output?: string;
}

export interface WorkflowRunResult {
  status: "COMPLETED" | "FAILED";
  steps: WorkflowExecutionStep[];
  finalOutput: string;
}

export class WorkflowEngine {
  private readonly router: SessionRouter;
  private readonly evidenceGate = new EvidenceGate();

  constructor(router: SessionRouter) {
    this.router = router;
  }

  private resolveAgent(step: WorkflowAgentStep): { agent: AgentType; engine: AdapterEngine } {
    if (step.agent) {
      const engine = step.engine || "cli";
      this.router.getRegistry().get(step.agent, engine);
      return { agent: step.agent, engine };
    }

    const required = step.requires || [];
    const matches = this.router.findAgentsByCapabilities(required, step.engine);
    if (matches.length === 0) {
      throw new Error(`No registered agent satisfies capabilities: ${required.join(", ") || "(none)"}`);
    }

    return { agent: matches[0].agent, engine: matches[0].engine };
  }

  private renderPrompt(
    template: string | undefined,
    input: string,
    previousOutput: string,
    evidence?: EvidenceReport
  ): string {
    const source = template || "{{input}}";
    return source
      .replaceAll("{{input}}", input)
      .replaceAll("{{previousOutput}}", previousOutput)
      .replaceAll("{{evidenceSummary}}", evidence?.summary || "")
      .replaceAll("{{gitDiff}}", evidence?.git.diffSummary || "")
      .replaceAll(
        "{{testResults}}",
        evidence?.tests.map((t) => `${t.passed ? "PASS" : "FAIL"}: ${t.command} - ${t.output || t.error || ""}`).join("\n") || ""
      );
  }

  private async waitForTask(taskId: string): Promise<TaskRecord> {
    while (true) {
      const task = await this.router.getTaskManager().getTask(taskId);
      if (!task) throw new Error(`Workflow task disappeared: ${taskId}`);
      if (task.status !== "queued" && task.status !== "running") return task;
      await sleep(500);
    }
  }

  async run(options: {
    workflow: WorkflowDefinition;
    input: string;
    cwd: string;
    project?: string;
    topic?: string;
    timeoutMs?: number;
  }): Promise<WorkflowRunResult> {
    const steps: WorkflowExecutionStep[] = [];
    let previousOutput = "";
    let latestEvidence: EvidenceReport | undefined;

    for (let index = 0; index < options.workflow.steps.length; index++) {
      const step = options.workflow.steps[index];

      if (step.type === "evidence") {
        latestEvidence = await this.evidenceGate.evaluate({
          cwd: options.cwd,
          testCommands: step.testCommands || [],
          timeoutMs: options.timeoutMs || 60000,
        });
        steps.push({
          index,
          role: step.role,
          type: "evidence",
          evidence: latestEvidence,
          output: latestEvidence.summary,
        });
        previousOutput = latestEvidence.summary;
        if (!latestEvidence.allPassed) {
          return { status: "FAILED", steps, finalOutput: latestEvidence.summary };
        }
        continue;
      }

      const resolved = this.resolveAgent(step);
      const prompt = this.renderPrompt(step.prompt, options.input, previousOutput, latestEvidence);
      const sent = await this.router.dispatch({
        agent: resolved.agent,
        engine: resolved.engine,
        prompt,
        cwd: options.cwd,
        project: options.project,
        topic: `${options.topic || "workflow"}:${step.role}:${index}`,
        taskType: step.taskType || "orchestration",
        timeoutMs: options.timeoutMs,
      });
      const task = await this.waitForTask(sent.taskId);
      steps.push({
        index,
        role: step.role,
        type: "agent",
        agent: resolved.agent,
        engine: resolved.engine,
        task,
        output: task.output,
      });
      previousOutput = task.output;
      if (task.status !== "completed") {
        return { status: "FAILED", steps, finalOutput: task.error || task.output };
      }
    }

    return { status: "COMPLETED", steps, finalOutput: previousOutput };
  }
}
