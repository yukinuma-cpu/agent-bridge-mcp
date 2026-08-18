import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionMetadata, AgentType, TaskType } from "../common/types.js";

export class SessionStore {
  private filePath: string;
  private sessions: Map<string, SessionMetadata> = new Map();
  private loaded = false;

  constructor(baseDir?: string) {
    const root = baseDir || process.cwd();
    this.filePath = path.join(root, "state", "sessions.json");
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const data = await fs.readFile(this.filePath, "utf-8");
      const list: SessionMetadata[] = JSON.parse(data);
      for (const s of list) {
        this.sessions.set(s.id, s);
      }
    } catch {
      // File doesn't exist yet or invalid JSON, initialize empty
      this.sessions = new Map();
      await this.save();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const list = Array.from(this.sessions.values());
    const tempPath = `${this.filePath}.${Date.now()}.tmp`;
    const json = JSON.stringify(list, null, 2);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tempPath, json, "utf-8");
    await fs.rename(tempPath, this.filePath);
  }

  async getSession(id: string): Promise<SessionMetadata | undefined> {
    await this.init();
    return this.sessions.get(id);
  }

  async listSessions(filter?: {
    agent?: AgentType;
    project?: string;
    topic?: string;
    taskType?: TaskType;
    status?: "active" | "archived";
  }): Promise<SessionMetadata[]> {
    await this.init();
    let list = Array.from(this.sessions.values());
    if (filter) {
      if (filter.agent) list = list.filter((s) => s.agent === filter.agent);
      if (filter.project) list = list.filter((s) => s.project === filter.project);
      if (filter.topic) list = list.filter((s) => s.topic === filter.topic);
      if (filter.taskType) list = list.filter((s) => s.taskType === filter.taskType);
      if (filter.status) list = list.filter((s) => s.status === filter.status);
    }
    return list.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  async findMatchingSession(options: {
    agent: AgentType;
    cwd: string;
    project?: string;
    topic?: string;
    taskType?: TaskType;
  }): Promise<SessionMetadata | undefined> {
    await this.init();
    const active = await this.listSessions({
      agent: options.agent,
      status: "active",
    });

    // Best match: agent + project + topic + taskType in same cwd
    const exact = active.find(
      (s) =>
        s.cwd === options.cwd &&
        s.project === options.project &&
        s.topic === options.topic &&
        s.taskType === options.taskType
    );
    if (exact) return exact;

    // Second best match: agent + project + topic in same cwd
    if (options.project && options.topic) {
      const topicMatch = active.find(
        (s) =>
          s.cwd === options.cwd &&
          s.project === options.project &&
          s.topic === options.topic
      );
      if (topicMatch) return topicMatch;
    }

    return undefined;
  }

  async createSession(data: {
    agent: AgentType;
    cwd: string;
    project?: string;
    topic?: string;
    taskType?: TaskType;
    externalSessionId?: string;
    summary?: string;
  }): Promise<SessionMetadata> {
    await this.init();
    const id = `sess_${data.agent}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const session: SessionMetadata = {
      id,
      agent: data.agent,
      externalSessionId: data.externalSessionId,
      project: data.project,
      topic: data.topic,
      taskType: data.taskType,
      cwd: data.cwd,
      createdAt: now,
      updatedAt: now,
      summary: data.summary,
      status: "active",
    };
    this.sessions.set(id, session);
    await this.save();
    return session;
  }

  async updateSession(
    id: string,
    updates: Partial<Omit<SessionMetadata, "id" | "agent" | "createdAt">>
  ): Promise<SessionMetadata | undefined> {
    await this.init();
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const updated: SessionMetadata = {
      ...session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, updated);
    await this.save();
    return updated;
  }
}
