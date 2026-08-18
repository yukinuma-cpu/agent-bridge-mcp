#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRouter } from "../router/session-router.js";
import { EvidenceGate } from "../evidence/evidence-gate.js";
import { ReviewLoopOrchestrator } from "../orchestrator/review-loop.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../");

const sessionRouter = new SessionRouter(rootDir);
const evidenceGate = new EvidenceGate();
const reviewLoopOrchestrator = new ReviewLoopOrchestrator(sessionRouter);

const server = new McpServer({
  name: "agent-bridge-mcp",
  version: "0.2.0",
});

// Tool 1: agent_send
server.tool(
  "agent_send",
  "Send an instruction to Claude Code or Codex CLI/SDK. Executes asynchronously in background and returns task_id.",
  {
    agent: z.enum(["claude", "codex", "antigravity"]).describe("Target agent: 'claude', 'codex', or 'antigravity' (agy CLI)"),
    prompt: z.string().describe("Instruction or prompt text for the agent"),
    cwd: z.string().optional().describe("Working directory for execution (default: current directory)"),
    sessionId: z.string().optional().describe("Specific internal session ID to resume"),
    project: z.string().optional().describe("Directory name of the project inside the workspace"),
    topic: z.string().optional().describe("Topic or feature name (e.g. 'presence', 'auth')"),
    model: z.string().optional().describe("Specific model name (e.g. 'sonnet', 'opus' for Claude; 'o3' for Codex)"),
    engine: z.enum(["cli", "sdk"]).optional().describe("Execution engine: 'cli' (default) or 'sdk'"),
    taskType: z
      .enum([
        "architecture",
        "implementation",
        "review",
        "adversarial_review",
        "investigation",
        "refactor",
        "test",
        "general",
      ])
      .optional()
      .describe("Role or nature of task"),
    forceNewSession: z.boolean().optional().describe("Set true to force create a new session instead of reusing"),
    timeoutMs: z.number().optional().describe("Execution timeout in milliseconds (default: 180000ms / 3min)"),
  },
  async (args) => {
    try {
      const result = await sessionRouter.dispatch({
        agent: args.agent,
        prompt: args.prompt,
        cwd: args.cwd,
        sessionId: args.sessionId,
        project: args.project,
        topic: args.topic,
        model: args.model,
        engine: args.engine,
        taskType: args.taskType,
        forceNewSession: args.forceNewSession,
        timeoutMs: args.timeoutMs || 180000,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to dispatch agent task: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 2: agent_status
server.tool(
  "agent_status",
  "Check the status, output, or error of a background task dispatched via agent_send.",
  {
    taskId: z.string().describe("Task ID returned from agent_send (e.g. 'task_claude_12345')"),
  },
  async (args) => {
    try {
      const task = await sessionRouter.getTaskManager().getTask(args.taskId);
      if (!task) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Task not found with ID: ${args.taskId}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(task, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to get task status: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 3: agent_sessions
server.tool(
  "agent_sessions",
  "List active or archived sessions tracked by Agent Bridge.",
  {
    agent: z.enum(["claude", "codex", "antigravity"]).optional().describe("Filter by agent type"),
    project: z.string().optional().describe("Filter by project"),
    topic: z.string().optional().describe("Filter by topic"),
    status: z.enum(["active", "archived"]).optional().describe("Filter by status"),
  },
  async (args) => {
    try {
      const sessions = await sessionRouter.getSessionStore().listSessions(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(sessions, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to list sessions: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 4: agent_cancel
server.tool(
  "agent_cancel",
  "Cancel a currently running agent task.",
  {
    taskId: z.string().describe("Task ID to cancel"),
  },
  async (args) => {
    try {
      const success = await sessionRouter.getTaskManager().cancelTask(args.taskId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ taskId: args.taskId, cancelled: success }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to cancel task: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 5: agent_evidence_check (Phase 6 Evidence Gate)
server.tool(
  "agent_evidence_check",
  "Run Evidence Gate validation: inspect git status/diff and execute test/typecheck/lint commands to produce empirical evidence report.",
  {
    cwd: z.string().optional().describe("Target workspace directory (default: current directory)"),
    testCommands: z
      .array(z.string())
      .optional()
      .describe("List of test commands to run (e.g. ['npm test', 'npx tsc --noEmit'])"),
    timeoutMs: z.number().optional().describe("Timeout per test command in ms (default: 60000ms)"),
  },
  async (args) => {
    try {
      const cwd = args.cwd || process.cwd();
      const report = await evidenceGate.evaluate({
        cwd,
        testCommands: args.testCommands || [],
        timeoutMs: args.timeoutMs || 60000,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Evidence Gate evaluation failed: ${err.message}`,
          },
        ],
      };
    }
  }
);

// Tool 6: agent_review_loop (Phase 5 Automated Review Loop)
server.tool(
  "agent_review_loop",
  "Execute full autonomous development loop: Codex implements -> Evidence Gate validates -> Claude reviews -> Auto-revision (up to max 2 revisions limit).",
  {
    prompt: z.string().describe("The feature specification or bugfix task description"),
    cwd: z.string().optional().describe("Target workspace directory (default: current directory)"),
    project: z.string().optional().describe("Directory name of the project inside the workspace"),
    topic: z.string().optional().describe("Topic or feature name (e.g. 'auth-fix')"),
    testCommands: z
      .array(z.string())
      .optional()
      .describe("Test commands for Evidence Gate (e.g. ['npm test'])"),
    maxRevisions: z.number().optional().describe("Maximum auto-revision retries (default: 2)"),
    engine: z.enum(["cli", "sdk"]).optional().describe("Engine to use: 'cli' (default) or 'sdk'"),
    timeoutMs: z.number().optional().describe("Timeout per turn in ms (default: 180000ms)"),
  },
  async (args) => {
    try {
      const cwd = args.cwd || process.cwd();
      const result = await reviewLoopOrchestrator.run({
        prompt: args.prompt,
        cwd,
        project: args.project,
        topic: args.topic,
        testCommands: args.testCommands,
        maxRevisions: args.maxRevisions,
        engine: args.engine,
        timeoutMs: args.timeoutMs,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Review loop execution failed: ${err.message}`,
          },
        ],
      };
    }
  }
);

async function main() {
  await sessionRouter.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agent Bridge MCP server (v0.2.0 Full-Spec) started on stdio");
}

main().catch((error) => {
  console.error("Server fatal error:", error);
  process.exit(1);
});
