import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import * as fs from "node:fs/promises";
import { SessionRouter } from "../router/session-router.js";
import { EvidenceGate } from "../evidence/evidence-gate.js";
import { GitManager } from "../evidence/git.js";
import { ReviewLoopOrchestrator } from "../orchestrator/review-loop.js";
import { WorkflowEngine } from "../orchestrator/workflow-engine.js";

export interface GatewayOptions {
  port?: number;
  /** 必須。未設定だと start() が拒否する（既定値は持たせない） */
  authToken?: string;
  /** セッション・タスクの状態ファイルを置くディレクトリ */
  rootDir?: string;
  /** `project` 名を解決する基準ディレクトリ。配下の各ディレクトリを1プロジェクトとみなす */
  workspaceDir?: string;
  /** バインドするアドレス。既定は 127.0.0.1（LAN 公開は明示指定が必要） */
  host?: string;
  /** CORS で許可するオリジン。既定は localhost / 127.0.0.1 のみ */
  allowedOrigins?: string[];
}

export class GatewayServer {
  private app: Hono;
  private port: number;
  private authToken: string;
  private rootDir: string;
  private workspaceDir: string;
  private host: string;
  private allowedOrigins?: string[];
  private sessionRouter: SessionRouter;
  private evidenceGate: EvidenceGate;
  private gitManager: GitManager;
  private reviewLoopOrchestrator: ReviewLoopOrchestrator;
  private workflowEngine: WorkflowEngine;
  private wsServer?: WebSocketServer;
  private activeClients: Set<WebSocket> = new Set();
  private httpServer?: http.Server;

  constructor(options?: GatewayOptions) {
    this.port = options?.port || parseInt(process.env.PORT || "3030", 10);
    this.authToken = options?.authToken || process.env.ABC_AUTH_TOKEN || "";
    this.rootDir = options?.rootDir || process.env.AGENT_BRIDGE_ROOT || process.cwd();
    this.workspaceDir = options?.workspaceDir || process.env.AGENT_BRIDGE_WORKSPACE || process.cwd();
    this.host = options?.host || process.env.AGENT_BRIDGE_HOST || "127.0.0.1";
    this.allowedOrigins =
      options?.allowedOrigins ||
      process.env.AGENT_BRIDGE_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);

    this.sessionRouter = new SessionRouter(this.rootDir, this.workspaceDir);
    this.evidenceGate = new EvidenceGate();
    this.gitManager = new GitManager();
    this.reviewLoopOrchestrator = new ReviewLoopOrchestrator(this.sessionRouter);
    this.workflowEngine = new WorkflowEngine(this.sessionRouter);

    this.app = new Hono();
    this.setupRoutes();
  }

  /** Resolve HTTP-provided cwd/project using the same workspace rule as MCP dispatch. */
  private cwdFromBody(body: { cwd?: string; project?: string }): string | null {
    if (!body.cwd && !body.project) return null;
    try {
      return this.sessionRouter.resolveWorkingDirectory({ cwd: body.cwd, project: body.project });
    } catch {
      return null;
    }
  }

  private async discoverProjects(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.workspaceDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private setupRoutes() {
    const allowed = this.allowedOrigins;
    this.app.use(
      "*",
      cors({
        origin: (origin) => {
          if (!origin) return origin;
          if (allowed) return allowed.includes(origin) ? origin : null;
          return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null;
        },
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
      })
    );

    this.app.use("/api/*", async (c, next) => {
      const authHeader = c.req.header("Authorization");
      const queryToken = c.req.query("token");
      const token = authHeader?.replace("Bearer ", "") || queryToken;

      if (!this.authToken || token !== this.authToken) {
        return c.json({ error: "Unauthorized: Invalid or missing token" }, 401);
      }
      await next();
    });

    this.app.get("/api/status", async (c) => {
      await this.sessionRouter.init();
      const tasks = await this.sessionRouter.getTaskManager().listTasks();
      const sessions = await this.sessionRouter.getSessionStore().listSessions();
      const runningTasks = tasks.filter((t) => t.status === "running" || t.status === "queued");

      return c.json({
        status: "online",
        timestamp: new Date().toISOString(),
        activeTasksCount: runningTasks.length,
        totalSessionsCount: sessions.length,
        runningTasks,
        host: {
          platform: process.platform,
          nodeVersion: process.version,
          rootDir: this.rootDir,
        },
      });
    });

    this.app.get("/api/projects", async (c) => {
      const projects = await this.discoverProjects();
      return c.json({ projects });
    });

    this.app.get("/api/capabilities", (c) => {
      return c.json({ agents: this.sessionRouter.listAgentCapabilities() });
    });

    this.app.get("/api/sessions", async (c) => {
      const agent = c.req.query("agent") as any;
      const project = c.req.query("project");
      const topic = c.req.query("topic");
      const sessions = await this.sessionRouter.getSessionStore().listSessions({ agent, project, topic });
      return c.json({ sessions });
    });

    this.app.get("/api/tasks", async (c) => {
      const agent = c.req.query("agent") as any;
      const sessionId = c.req.query("sessionId");
      const status = c.req.query("status") as any;
      const project = c.req.query("project");
      let tasks = await this.sessionRouter.getTaskManager().listTasks({ agent, sessionId, status });
      if (project && project !== "すべて") {
        tasks = tasks.filter((t) => t.project === project);
      }
      return c.json({ tasks });
    });

    this.app.get("/api/tasks/:id", async (c) => {
      const id = c.req.param("id");
      const task = await this.sessionRouter.getTaskManager().getTask(id);
      if (!task) return c.json({ error: "Task not found" }, 404);
      return c.json({ task });
    });

    this.app.post("/api/dispatch", async (c) => {
      const body = await c.req.json();
      const cwd = this.cwdFromBody(body);
      if (!cwd) {
        return c.json({ error: "Either 'cwd' or a 'project' inside the workspace is required" }, 400);
      }
      try {
        const result = await this.sessionRouter.dispatch({
          agent: body.agent,
          prompt: body.prompt,
          cwd,
          sessionId: body.sessionId,
          project: body.project,
          topic: body.topic,
          model: body.model,
          engine: body.engine || "cli",
          taskType: body.taskType,
          forceNewSession: body.forceNewSession,
          timeoutMs: body.timeoutMs,
        });

        this.broadcast({ type: "task:dispatched", payload: result });
        return c.json(result);
      } catch (err: any) {
        return c.json({ error: err.message }, 400);
      }
    });

    this.app.post("/api/tasks/:id/cancel", async (c) => {
      const id = c.req.param("id");
      const success = await this.sessionRouter.getTaskManager().cancelTask(id);
      this.broadcast({ type: "task:cancelled", payload: { taskId: id, success } });
      return c.json({ taskId: id, cancelled: success });
    });

    this.app.post("/api/evidence", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const cwd = this.cwdFromBody(body) || this.sessionRouter.getWorkspaceDir();
      const report = await this.evidenceGate.evaluate({
        cwd,
        testCommands: body.testCommands || [],
        timeoutMs: body.timeoutMs || 60000,
      });
      return c.json(report);
    });

    this.app.post("/api/git/commit-push", async (c) => {
      const body = await c.req.json();
      const cwd = this.cwdFromBody(body);
      if (!cwd) {
        return c.json({ error: "Either 'cwd' or a 'project' inside the workspace is required" }, 400);
      }
      const message = body.message || "feat: AI verified implementation approved from mobile cockpit";
      const result = await this.gitManager.commitAndPush(cwd, message);

      this.broadcast({
        type: result.pushed ? "git:pushed" : "git:push_failed",
        payload: {
          project: body.project,
          success: result.success,
          committed: result.committed,
          pushed: result.pushed,
          message,
          error: result.error,
        },
      });

      return c.json(result, result.success ? 200 : 500);
    });

    this.app.post("/api/workflow", async (c) => {
      const body = await c.req.json();
      const cwd = this.cwdFromBody(body);
      if (!cwd) {
        return c.json({ error: "Either 'cwd' or a 'project' inside the workspace is required" }, 400);
      }
      if (!body.workflow || !Array.isArray(body.workflow.steps) || body.workflow.steps.length === 0) {
        return c.json({ error: "workflow.steps must be a non-empty array" }, 400);
      }
      try {
        const result = await this.workflowEngine.run({
          workflow: body.workflow,
          input: body.input || "",
          cwd,
          project: body.project,
          topic: body.topic,
          timeoutMs: body.timeoutMs,
        });
        this.broadcast({ type: "workflow:completed", payload: result });
        return c.json(result, result.status === "COMPLETED" ? 200 : 422);
      } catch (err: any) {
        this.broadcast({ type: "workflow:failed", payload: { error: err.message } });
        return c.json({ error: err.message }, 400);
      }
    });

    this.app.post("/api/review-loop", async (c) => {
      const body = await c.req.json();
      const cwd = this.cwdFromBody(body);
      if (!cwd) {
        return c.json({ error: "Either 'cwd' or a 'project' inside the workspace is required" }, 400);
      }

      this.reviewLoopOrchestrator
        .run({
          prompt: body.prompt,
          cwd,
          project: body.project,
          topic: body.topic,
          implementer: body.implementer,
          reviewer: body.reviewer,
          testCommands: body.testCommands,
          maxRevisions: body.maxRevisions,
          engine: body.engine,
          timeoutMs: body.timeoutMs,
        })
        .then((result) => {
          this.broadcast({ type: "review_loop:completed", payload: result });
        })
        .catch((err) => {
          this.broadcast({ type: "review_loop:failed", payload: { error: err.message } });
        });

      return c.json({
        status: "dispatched",
        message: "Review loop started in background",
        project: body.project,
        topic: body.topic,
      });
    });
  }

  public broadcast(event: { type: string; payload: any }) {
    const message = JSON.stringify(event);
    for (const client of this.activeClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  async start(): Promise<void> {
    if (!this.authToken) {
      throw new Error(
        "Auth token is not configured. Set the ABC_AUTH_TOKEN environment variable " +
          "(or pass authToken) to a secret value before starting the gateway."
      );
    }

    await this.sessionRouter.init();

    this.sessionRouter.getTaskManager().setOutputListener((taskId, chunk) => {
      this.broadcast({ type: "task:chunk", payload: { taskId, chunk } });
    });

    return new Promise((resolve) => {
      const serverInstance = serve(
        {
          fetch: this.app.fetch,
          port: this.port,
          hostname: this.host,
        },
        (info) => {
          console.log(`🚀 Agent Bridge Gateway running at http://${this.host}:${info.port}`);
          console.log(`🔑 Auth token: configured (${this.authToken.length} chars)`);
          if (this.host !== "127.0.0.1" && this.host !== "localhost") {
            console.warn(
              `⚠️  Listening on ${this.host}. This exposes task dispatch and git push to the network.`
            );
          }
          resolve();
        }
      );

      this.httpServer = serverInstance as unknown as http.Server;
      this.wsServer = new WebSocketServer({ server: this.httpServer, path: "/ws" });

      this.wsServer.on("connection", (ws, req) => {
        const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
        const token = url.searchParams.get("token");

        if (!this.authToken || token !== this.authToken) {
          ws.close(4001, "Unauthorized");
          return;
        }

        this.activeClients.add(ws);
        ws.send(JSON.stringify({ type: "connected", message: "Connected to Agent Bridge Gateway" }));

        ws.on("close", () => {
          this.activeClients.delete(ws);
        });

        ws.on("message", async (data) => {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === "ping") {
              ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            }
          } catch {
            // ignore
          }
        });
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.activeClients) {
      client.close();
    }
    this.wsServer?.close();
  }
}
