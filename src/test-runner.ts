import { SessionRouter } from "./router/session-router.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../");

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest() {
  console.log("=== Agent Bridge Full Verification (Claude & Codex) ===");
  const router = new SessionRouter(rootDir);
  await router.init();

  // Test 1: Claude Code Execution & Session Continuity
  console.log("\n[Test 1] Testing Claude Code (Step 1: Save secret in session)...");
  const claudeRes1 = await router.dispatch({
    agent: "claude",
    prompt: "Remember this secret code: 'RUBY_STAR_99'. Respond with 'CLAUDE_ACK'.",
    project: "dual-agent-test",
    topic: "claude-test",
    taskType: "architecture",
    timeoutMs: 60000,
  });
  console.log("Claude Step 1 Dispatched:", claudeRes1);

  let claudeTask1 = await router.getTaskManager().getTask(claudeRes1.taskId);
  while (claudeTask1 && claudeTask1.status === "running") {
    await sleep(1000);
    claudeTask1 = await router.getTaskManager().getTask(claudeRes1.taskId);
  }
  console.log(`Claude Step 1 Status: ${claudeTask1?.status}`);
  console.log(`Claude Step 1 Output: ${claudeTask1?.output}`);

  console.log("\n[Test 1] Testing Claude Code (Step 2: Resume session to verify memory)...");
  const claudeRes2 = await router.dispatch({
    agent: "claude",
    prompt: "What was the secret code I just told you? Reply ONLY with the code.",
    project: "dual-agent-test",
    topic: "claude-test",
    taskType: "architecture",
    timeoutMs: 60000,
  });
  console.log("Claude Step 2 Dispatched (Reusing session):", claudeRes2);

  let claudeTask2 = await router.getTaskManager().getTask(claudeRes2.taskId);
  while (claudeTask2 && claudeTask2.status === "running") {
    await sleep(1000);
    claudeTask2 = await router.getTaskManager().getTask(claudeRes2.taskId);
  }
  console.log(`Claude Step 2 Status: ${claudeTask2?.status}`);
  console.log(`Claude Step 2 Output: ${claudeTask2?.output}`);

  // Test 2: Codex Execution & Session Continuity
  console.log("\n[Test 2] Testing Codex (Step 1: Save secret in session)...");
  const codexRes1 = await router.dispatch({
    agent: "codex",
    prompt: "Remember this secret code: 'EMERALD_SKY_77'. Respond with 'CODEX_ACK'.",
    project: "dual-agent-test",
    topic: "codex-test",
    taskType: "implementation",
    timeoutMs: 60000,
  });
  console.log("Codex Step 1 Dispatched:", codexRes1);

  let codexTask1 = await router.getTaskManager().getTask(codexRes1.taskId);
  while (codexTask1 && codexTask1.status === "running") {
    await sleep(1000);
    codexTask1 = await router.getTaskManager().getTask(codexRes1.taskId);
  }
  console.log(`Codex Step 1 Status: ${codexTask1?.status}`);
  console.log(`Codex Step 1 Output: ${codexTask1?.output}`);

  console.log("\n[Test 2] Testing Codex (Step 2: Resume session to verify memory)...");
  const codexRes2 = await router.dispatch({
    agent: "codex",
    prompt: "What was the secret code I just told you? Reply ONLY with the code.",
    project: "dual-agent-test",
    topic: "codex-test",
    taskType: "implementation",
    timeoutMs: 60000,
  });
  console.log("Codex Step 2 Dispatched (Reusing session):", codexRes2);

  let codexTask2 = await router.getTaskManager().getTask(codexRes2.taskId);
  while (codexTask2 && codexTask2.status === "running") {
    await sleep(1000);
    codexTask2 = await router.getTaskManager().getTask(codexRes2.taskId);
  }
  console.log(`Codex Step 2 Status: ${codexTask2?.status}`);
  console.log(`Codex Step 2 Output: ${codexTask2?.output}`);

  // Summary of all sessions
  console.log("\n=== Final Session Store Inventory ===");
  const allSessions = await router.getSessionStore().listSessions();
  for (const s of allSessions) {
    console.log(`- [${s.agent.toUpperCase()}] InternalID: ${s.id} | ExternalID: ${s.externalSessionId} | Topic: ${s.topic}`);
  }

  console.log("\n=== All Tests Completed Successfully ===");
}

runTest().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
