import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ChildProcess } from "node:child_process";
import { TaskRecord, TaskStatus, AgentType, TaskType } from "../common/types.js";

export class TaskManager {
  private filePath: string;
  private tasks: Map<string, TaskRecord> = new Map();
  private runningProcesses: Map<string, ChildProcess> = new Map();
  private loaded = false;
  private onOutputChunk?: (taskId: string, chunk: string) => void;

  constructor(baseDir?: string, onOutputChunk?: (taskId: string, chunk: string) => void) {
    const root = baseDir || process.cwd();
    this.filePath = path.join(root, "state", "tasks.json");
    this.onOutputChunk = onOutputChunk;
  }

  setOutputListener(listener: (taskId: string, chunk: string) => void) {
    this.onOutputChunk = listener;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const data = await fs.readFile(this.filePath, "utf-8");
      const list: TaskRecord[] = JSON.parse(data);
      for (const t of list) {
        if (t.status === "running" || t.status === "queued") {
          t.status = "failed";
          t.error = "Interrupted by system restart";
        }
        this.tasks.set(t.id, t);
      }
    } catch {
      this.tasks = new Map();
      await this.save();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const list = Array.from(this.tasks.values());
    const tempPath = `${this.filePath}.${Date.now()}.tmp`;
    const json = JSON.stringify(list, null, 2);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tempPath, json, "utf-8");
    await fs.rename(tempPath, this.filePath);
  }

  async createTask(data: {
    agent: AgentType;
    sessionId: string;
    externalSessionId?: string;
    taskType?: TaskType;
    project?: string;
    topic?: string;
    prompt: string;
    cwd: string;
  }): Promise<TaskRecord> {
    await this.init();
    const id = `task_${data.agent}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id,
      agent: data.agent,
      sessionId: data.sessionId,
      externalSessionId: data.externalSessionId,
      taskType: data.taskType || "general",
      project: data.project,
      topic: data.topic,
      prompt: data.prompt,
      cwd: data.cwd,
      status: "queued",
      createdAt: now,
      output: "",
    };
    this.tasks.set(id, record);
    await this.save();
    return record;
  }

  registerProcess(taskId: string, child: ChildProcess): void {
    this.runningProcesses.set(taskId, child);
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      this.save().catch(console.error);
    }
  }

  appendOutput(taskId: string, chunk: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.output += chunk;
      if (this.onOutputChunk) {
        this.onOutputChunk(taskId, chunk);
      }
    }
  }

  async completeTask(
    taskId: string,
    result: {
      status: TaskStatus;
      output: string;
      error?: string;
      exitCode?: number | null;
      externalSessionId?: string;
    }
  ): Promise<TaskRecord | undefined> {
    await this.init();
    this.runningProcesses.delete(taskId);
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    task.status = result.status;
    task.output = result.output;
    task.error = result.error;
    task.exitCode = result.exitCode;
    if (result.externalSessionId) {
      task.externalSessionId = result.externalSessionId;
    }
    task.completedAt = new Date().toISOString();
    await this.save();
    return task;
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    await this.init();
    return this.tasks.get(taskId);
  }

  async cancelTask(taskId: string): Promise<boolean> {
    await this.init();
    const child = this.runningProcesses.get(taskId);
    if (child) {
      child.kill();
      this.runningProcesses.delete(taskId);
    }
    const task = this.tasks.get(taskId);
    if (task && (task.status === "running" || task.status === "queued")) {
      task.status = "cancelled";
      task.completedAt = new Date().toISOString();
      await this.save();
      return true;
    }
    return false;
  }

  async listTasks(filter?: {
    agent?: AgentType;
    sessionId?: string;
    status?: TaskStatus;
  }): Promise<TaskRecord[]> {
    await this.init();
    let list = Array.from(this.tasks.values());
    if (filter) {
      if (filter.agent) list = list.filter((t) => t.agent === filter.agent);
      if (filter.sessionId) list = list.filter((t) => t.sessionId === filter.sessionId);
      if (filter.status) list = list.filter((t) => t.status === filter.status);
    }
    return list.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}
