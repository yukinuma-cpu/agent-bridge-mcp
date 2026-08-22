#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRouter } from "../router/session-router.js";
import { EvidenceGate } from "../evidence/evidence-gate.js";
import { ReviewLoopOrchestrator } from "../orchestrator/review-loop.js";
import { WorkflowEngine } from "../orchestrator/workflow-engine.js";
import type { WorkflowDefinition } from "../common/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../");

const sessionRouter = new SessionRouter(rootDir);
const evidenceGate = new EvidenceGate();
const reviewLoopOrchestrator = new ReviewLoopOrchestrator(sessionRouter);
const workflowEngine = new WorkflowEngine(sessionRouter);

const server = new McpServer({ name: "agent-bridge-mcp", version: "0.3.0" });

const taskTypeSchema = z.enum([
  "architecture",
  "implementation",
  "review",
  "adversarial_review",
  "investigation",
  "refactor",
  "test",
  "orchestration",
  "general",
]);
const capabilitySchema = z.enum([
  "sessions",
  "streaming",
  "cancellation",
  "models",
  "sandboxControl",
  "fileTools",
  "shellTools",
]);
const roleSchema = z.enum(["planner", "implementer", "reviewer", "verifier", "custom"]);

server.tool(
  "agent_send",
  "Dispatch a task to any registered agent adapter. Agent identifiers are registry-defined, not hard-coded by the router.",
  {
    agent: z.string().min(1),
    prompt: z.string(),
    cwd: z.string().optional(),
    sessionId: z.string().optional(),
    project: z.string().optional(),
    topic: z.string().optional(),
    model: z.string().optional(),
    engine: z.enum(["cli", "sdk"]).optional(),
    taskType: taskTypeSchema.optional(),
    forceNewSession: z.boolean().optional(),
    timeoutMs: z.number().optional(),
  },
  async (args) => {
    try {
      const result = await sessionRouter.dispatch({ ...args, timeoutMs: args.timeoutMs || 180000 });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to dispatch agent task: ${err.message}` }] };
    }
  }
);

server.tool(
  "agent_capabilities",
  "List registered agent adapters and their capabilities, or find adapters matching required capabilities.",
  {
    requires: z.array(capabilitySchema).optional(),
    engine: z.enum(["cli", "sdk"]).optional(),
  },
  async (args) => {
    const result = args.requires?.length
      ? sessionRouter.findAgentsByCapabilities(args.requires, args.engine)
      : sessionRouter.listAgentCapabilities().filter((entry) => !args.engine || entry.engine === args.engine);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "agent_status",
  "Check status/output for a dispatched task.",
  { taskId: z.string() },
  async ({ taskId }) => {
    const task = await sessionRouter.getTaskManager().getTask(taskId);
    if (!task) return { isError: true, content: [{ type: "text", text: `Task not found: ${taskId}` }] };
    return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
  }
);

server.tool(
  "agent_sessions",
  "List tracked sessions.",
  {
    agent: z.string().optional(),
    project: z.string().optional(),
    topic: z.string().optional(),
    status: z.enum(["active", "archived"]).optional(),
  },
  async (args) => {
    const sessions = await sessionRouter.getSessionStore().listSessions(args);
    return { content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }] };
  }
);

server.tool(
  "agent_cancel",
  "Cancel a running agent task.",
  { taskId: z.string() },
  async ({ taskId }) => {
    const cancelled = await sessionRouter.getTaskManager().cancelTask(taskId);
    return { content: [{ type: "text", text: JSON.stringify({ taskId, cancelled }, null, 2) }] };
  }
);

server.tool(
  "agent_evidence_check",
  "Run fail-closed git/test evidence validation.",
  {
    cwd: z.string().optional(),
    project: z.string().optional(),
    testCommands: z.array(z.string()).optional(),
    timeoutMs: z.number().optional(),
  },
  async (args) => {
    try {
      const cwd = sessionRouter.resolveWorkingDirectory({ cwd: args.cwd, project: args.project });
      const report = await evidenceGate.evaluate({
        cwd,
        testCommands: args.testCommands || [],
        timeoutMs: args.timeoutMs || 60000,
      });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: `Evidence Gate failed: ${err.message}` }] };
    }
  }
);

const workflowAgentStepSchema = z.object({
  type: z.literal("agent"),
  role: roleSchema,
  agent: z.string().optional(),
  engine: z.enum(["cli", "sdk"]).optional(),
  requires: z.array(capabilitySchema).optional(),
  prompt: z.string().optional(),
  taskType: taskTypeSchema.optional(),
});
const workflowEvidenceStepSchema = z.object({
  type: z.literal("evidence"),
  role: z.literal("verifier"),
  testCommands: z.array(z.string()).optional(),
});

server.tool(
  "agent_workflow",
  "Run a generic role-based workflow. Agent steps may name an adapter or request capabilities and let the registry choose one.",
  {
    input: z.string(),
    cwd: z.string().optional(),
    project: z.string().optional(),
    topic: z.string().optional(),
    timeoutMs: z.number().optional(),
    steps: z.array(z.discriminatedUnion("type", [workflowAgentStepSchema, workflowEvidenceStepSchema])).min(1),
  },
  async (args) => {
    try {
      const cwd = sessionRouter.resolveWorkingDirectory({ cwd: args.cwd, project: args.project });
      const workflow: WorkflowDefinition = { steps: args.steps };
      const result = await workflowEngine.run({
        workflow,
        input: args.input,
        cwd,
        project: args.project,
        topic: args.topic,
        timeoutMs: args.timeoutMs,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: `Workflow failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "agent_review_loop",
  "Compatibility preset: implement -> evidence -> review -> revisions. Implementer and reviewer are selectable registered agents.",
  {
    prompt: z.string(),
    cwd: z.string().optional(),
    project: z.string().optional(),
    topic: z.string().optional(),
    implementer: z.string().optional(),
    reviewer: z.string().optional(),
    testCommands: z.array(z.string()).optional(),
    maxRevisions: z.number().optional(),
    engine: z.enum(["cli", "sdk"]).optional(),
    timeoutMs: z.number().optional(),
  },
  async (args) => {
    try {
      const cwd = sessionRouter.resolveWorkingDirectory({ cwd: args.cwd, project: args.project });
      const result = await reviewLoopOrchestrator.run({ ...args, cwd });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: "text", text: `Review loop failed: ${err.message}` }] };
    }
  }
);

async function main() {
  await sessionRouter.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agent Bridge MCP server (v0.3.0) started on stdio");
}

main().catch((error) => {
  console.error("Server fatal error:", error);
  process.exit(1);
});
