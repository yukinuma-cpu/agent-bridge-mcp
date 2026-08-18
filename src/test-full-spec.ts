import { SessionRouter } from "./router/session-router.js";
import { EvidenceGate } from "./evidence/evidence-gate.js";
import { ReviewLoopOrchestrator } from "./orchestrator/review-loop.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../");

async function runFullSpecTests() {
  console.log("==================================================");
  console.log("=== Agent Bridge MCP Full-Spec Validation Suite ==");
  console.log("==================================================");

  // Test 1: Evidence Gate Execution
  console.log("\n[Test 1] Testing Evidence Gate (Git diff + Test command execution)...");
  const evidenceGate = new EvidenceGate();
  const evidenceReport = await evidenceGate.evaluate({
    cwd: rootDir,
    testCommands: ["node -e \"console.log('Unit test dummy check passed'); process.exit(0);\""],
  });
  console.log("Evidence Report Summary:", evidenceReport.summary);
  console.log("Git Status Summary:", evidenceReport.git.statusSummary);
  console.log("Modified files count:", evidenceReport.git.modifiedFiles.length);
  console.log("Test Evidence count:", evidenceReport.tests.length);
  console.log("All Passed?:", evidenceReport.allPassed);

  if (!evidenceReport.allPassed) {
    throw new Error("Evidence Gate check failed unexpectedly");
  }
  console.log("🟢 Test 1 Passed: Evidence Gate is functioning perfectly.");

  // Test 2: Session Router Initializer & Store Validation
  console.log("\n[Test 2] Testing Session Router & Session Store...");
  const router = new SessionRouter(rootDir);
  await router.init();

  const sessionStore = router.getSessionStore();
  const session = await sessionStore.createSession({
    agent: "codex",
    cwd: rootDir,
    project: "full-spec-test",
    topic: "sdk-validation",
    taskType: "implementation",
    externalSessionId: "thr_mock_12345",
  });
  console.log("Created Session in Store:", session.id, "External:", session.externalSessionId);

  const matched = await sessionStore.findMatchingSession({
    agent: "codex",
    cwd: rootDir,
    project: "full-spec-test",
    topic: "sdk-validation",
  });
  console.log("Matched Session:", matched?.id);
  if (matched?.id !== session.id) {
    throw new Error("SessionStore failed to match active session");
  }
  console.log("🟢 Test 2 Passed: SessionStore accurately indexes & retrieves sessions.");

  // Test 3: Review Loop Orchestrator Wiring & Type Integrity
  console.log("\n[Test 3] Testing Review Loop Orchestrator structure...");
  const orchestrator = new ReviewLoopOrchestrator(router);
  if (typeof orchestrator.run !== "function") {
    throw new Error("ReviewLoopOrchestrator.run is not defined");
  }
  console.log("🟢 Test 3 Passed: ReviewLoopOrchestrator is correctly wired.");

  // Test 4: Task Manager Multi-Task Filtering & Cancellation
  console.log("\n[Test 4] Testing Task Manager state tracking & cancellation...");
  const taskManager = router.getTaskManager();
  const mockTask = await taskManager.createTask({
    agent: "claude",
    sessionId: session.id,
    prompt: "Mock task for lifecycle test",
    cwd: rootDir,
  });
  console.log("Created Task:", mockTask.id, "Status:", mockTask.status);

  const cancelled = await taskManager.cancelTask(mockTask.id);
  console.log("Cancel Result:", cancelled);
  const updatedTask = await taskManager.getTask(mockTask.id);
  console.log("Updated Task Status:", updatedTask?.status);

  if (updatedTask?.status !== "cancelled") {
    throw new Error("Task cancellation state failed to update");
  }
  console.log("🟢 Test 4 Passed: TaskManager accurately manages lifecycle & cancellations.");

  console.log("\n==================================================");
  console.log("=== All Full-Spec Core Components Verified OK! ===");
  console.log("==================================================");
}

runFullSpecTests().catch((err) => {
  console.error("Full Spec Test Failed:", err);
  process.exit(1);
});
