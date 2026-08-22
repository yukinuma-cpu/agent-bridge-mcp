import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EvidenceGate } from "./evidence/evidence-gate.js";
import { GitManager } from "./evidence/git.js";
import { SessionRouter } from "./router/session-router.js";
import { TaskManager } from "./tasks/task-manager.js";
import { parseReviewVerdict } from "./orchestrator/review-loop.js";

const execFileAsync = promisify(execFile);

async function testVerdictParsing() {
  assert.equal(parseReviewVerdict("PASS\nLooks good"), "PASS");
  assert.equal(parseReviewVerdict("REVISE: tests do not PASS"), "REVISE");
  assert.equal(parseReviewVerdict("The implementation should PASS after fixes"), "REVISE");
  assert.equal(parseReviewVerdict("ESCALATE requires product decision"), "ESCALATE");
}

async function testEvidenceFailClosed(repoRoot: string) {
  const gate = new EvidenceGate();
  const empty = await gate.evaluate({ cwd: repoRoot, testCommands: [] });
  assert.equal(empty.allPassed, false, "empty evidence must not pass");

  const verified = await gate.evaluate({
    cwd: repoRoot,
    testCommands: ["node -e \"process.exit(0)\""],
  });
  assert.equal(verified.allPassed, true, "successful verification command should pass in a git repo");
}

async function testWorkspaceBoundary(tempRoot: string) {
  const workspace = path.join(tempRoot, "workspace");
  const state = path.join(tempRoot, "state-root");
  await fs.mkdir(path.join(workspace, "project-a"), { recursive: true });

  const router = new SessionRouter(state, workspace);
  assert.equal(router.resolveWorkingDirectory({ project: "project-a" }), path.join(workspace, "project-a"));
  assert.throws(
    () => router.resolveWorkingDirectory({ cwd: path.join(tempRoot, "outside") }),
    /outside AGENT_BRIDGE_WORKSPACE/
  );
}

async function testCancellationIsTerminal(tempRoot: string) {
  const manager = new TaskManager(path.join(tempRoot, "task-state"));
  const task = await manager.createTask({
    agent: "codex",
    sessionId: "sess_test",
    prompt: "test",
    cwd: tempRoot,
  });

  let cancellationCalled = false;
  manager.registerCancellation(task.id, () => {
    cancellationCalled = true;
  });

  assert.equal(await manager.cancelTask(task.id), true);
  assert.equal(cancellationCalled, true);

  await manager.completeTask(task.id, {
    status: "completed",
    output: "late completion",
    exitCode: 0,
  });

  assert.equal((await manager.getTask(task.id))?.status, "cancelled");
}

async function testPushFailureIsFailure(tempRoot: string) {
  const repo = path.join(tempRoot, "git-no-remote");
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "agent-bridge-test@example.invalid"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Agent Bridge Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "file.txt"), "first\n", "utf-8");
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  await fs.writeFile(path.join(repo, "file.txt"), "second\n", "utf-8");

  const result = await new GitManager().commitAndPush(repo, "test commit");
  assert.equal(result.committed, true);
  assert.equal(result.pushed, false);
  assert.equal(result.success, false);
}

async function testExplicitSessionMismatch(tempRoot: string) {
  const workspace = path.join(tempRoot, "session-workspace");
  const state = path.join(tempRoot, "session-state");
  await fs.mkdir(workspace, { recursive: true });
  const router = new SessionRouter(state, workspace);
  await router.init();

  const session = await router.getSessionStore().createSession({
    agent: "claude",
    cwd: workspace,
    project: "demo",
  });

  await assert.rejects(
    () =>
      router.dispatch({
        agent: "codex",
        prompt: "must fail before spawning codex",
        cwd: workspace,
        project: "demo",
        sessionId: session.id,
      }),
    /belongs to agent 'claude'/
  );
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bridge-hardening-"));

  try {
    await testVerdictParsing();
    await testEvidenceFailClosed(repoRoot);
    await testWorkspaceBoundary(tempRoot);
    await testCancellationIsTerminal(tempRoot);
    await testPushFailureIsFailure(tempRoot);
    await testExplicitSessionMismatch(tempRoot);
    console.log("Hardening integration tests passed");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
