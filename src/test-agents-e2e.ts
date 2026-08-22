import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRouter } from "./router/session-router.js";
import type { AgentType } from "./common/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../");

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTask(router: SessionRouter, taskId: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const task = await router.getTaskManager().getTask(taskId);
    if (task && !["queued", "running"].includes(task.status)) return task;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function verifyContinuity(router: SessionRouter, agent: AgentType, secret: string) {
  const topic = `e2e-${agent}-${Date.now()}`;
  const first = await router.dispatch({
    agent,
    prompt: `Remember this exact secret for the next turn: ${secret}. Reply only ACK.`,
    cwd: repoRoot,
    topic,
    taskType: "general",
    forceNewSession: true,
    timeoutMs: 120_000,
  });
  const firstTask = await waitForTask(router, first.taskId);
  assert.equal(firstTask.status, "completed", `${agent} first turn failed: ${firstTask.error || firstTask.output}`);
  assert.ok(firstTask.externalSessionId, `${agent} did not persist an external session/conversation ID`);

  const second = await router.dispatch({
    agent,
    prompt: "Reply only with the exact secret I asked you to remember in the previous turn.",
    cwd: repoRoot,
    topic,
    taskType: "general",
    timeoutMs: 120_000,
  });
  assert.equal(second.sessionId, first.sessionId, `${agent} did not reuse the internal Agent Bridge session`);

  const secondTask = await waitForTask(router, second.taskId);
  assert.equal(secondTask.status, "completed", `${agent} resumed turn failed: ${secondTask.error || secondTask.output}`);
  assert.ok(secondTask.output.includes(secret), `${agent} did not retain context; output was: ${secondTask.output}`);
}

async function main() {
  const router = new SessionRouter(repoRoot, repoRoot);
  await router.init();

  await verifyContinuity(router, "claude", `CLAUDE_${Date.now()}`);
  await verifyContinuity(router, "codex", `CODEX_${Date.now()}`);
  await verifyContinuity(router, "antigravity", `AGY_${Date.now()}`);

  console.log("Live Claude/Codex/Antigravity E2E passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
