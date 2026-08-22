# agent-bridge-mcp

A capability-aware MCP server and HTTP/WebSocket gateway for orchestrating interchangeable coding agents.

Agent Bridge treats each agent as an adapter behind a common runtime contract. The core router does not hard-code Claude, Codex, or Antigravity behavior; registered adapters advertise capabilities such as sessions, streaming, cancellation, model selection, sandbox control, file tools, and shell tools. Workflows may name a specific agent or select one by required capabilities.

> **Status: experimental.** Interfaces may still change. The runtime is intended for trusted local development environments and should not be exposed to untrusted networks.

## Architecture

```text
MCP / HTTP / WebSocket
        |
        v
  SessionRouter
        |
        v
   AgentRegistry
        |
   AgentAdapter
   /    |       \
Claude Codex  Antigravity  ...
        |
        +--> TaskManager
        +--> SessionStore

WorkflowEngine ----> EvidenceGate ----> Git / tests / typecheck / lint
     |
     +--> ReviewLoop preset
```

The built-in adapters currently cover:

- **Claude Code CLI**
- **Codex CLI**
- **Codex SDK**
- **Antigravity (`agy`) CLI**

Additional agents can be added by implementing and registering another `AgentAdapter`; the core `AgentType` is not a closed union of built-in names.

## Core concepts

### Agent Registry and capabilities

Each registered adapter declares:

- `sessions`
- `streaming`
- `cancellation`
- `models`
- `sandboxControl`
- `fileTools`
- `shellTools`

Call `agent_capabilities` over MCP or `GET /api/capabilities` over HTTP to inspect what is available.

A workflow can select a concrete adapter:

```yaml
- type: agent
  role: implementer
  agent: codex
  engine: cli
```

or request capabilities and let the registry choose:

```yaml
- type: agent
  role: implementer
  requires:
    - sessions
    - fileTools
    - shellTools
```

### Generic workflows

`WorkflowEngine` executes ordered role-based steps. An agent step can receive:

- `{{input}}`
- `{{previousOutput}}`
- `{{evidenceSummary}}`
- `{{gitDiff}}`
- `{{testResults}}`

Evidence steps are fail-closed: no verification commands means no verified PASS.

The older implement → evidence → review loop remains available as a compatibility preset on top of the generic workflow runtime. Implementer and reviewer are selectable registered agents rather than fixed core dependencies.

### Sessions and tasks

Agent Bridge tracks internal sessions and external agent session/thread/conversation IDs. Matching considers agent, engine, workspace, project, topic, and task type. Explicit session reuse is rejected when the requested agent/engine/workspace is incompatible.

Every dispatch creates a task record with status, output, error, and exit code. Cancellation is terminal; late completion cannot resurrect a cancelled task.

## Install

```bash
npm install -g @yukinuma/agent-bridge-mcp
```

Requires Node.js 20+ and whichever agent CLIs you intend to drive already installed and authenticated.

### Antigravity on Windows

`agy` expects a real terminal. On Windows the adapter runs it under `winpty` when available and keeps stdin open for the call. It persists the returned conversation ID and resumes with `--conversation` on later turns.

Set `WINPTY_PATH` or `AGY_PATH` if either binary is in a non-standard location. Non-Windows Antigravity execution is not yet well tested.

## Use as an MCP server

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "agent-bridge-mcp",
      "env": {
        "AGENT_BRIDGE_WORKSPACE": "/path/to/your/projects"
      }
    }
  }
}
```

MCP tools:

| Tool | Purpose |
| --- | --- |
| `agent_send` | Dispatch to any registered agent/engine |
| `agent_capabilities` | List adapters or find capability matches |
| `agent_status` | Inspect a task |
| `agent_sessions` | List tracked sessions |
| `agent_cancel` | Cancel a task |
| `agent_evidence_check` | Run fail-closed repository verification |
| `agent_workflow` | Execute a generic role-based workflow |
| `agent_review_loop` | Run the compatibility implement/review preset |

## Use as an HTTP/WebSocket gateway

```bash
export ABC_AUTH_TOKEN="$(openssl rand -hex 24)"
export AGENT_BRIDGE_WORKSPACE="/path/to/your/projects"
agent-bridge-gateway
```

The gateway **refuses to start without `ABC_AUTH_TOKEN`**.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ABC_AUTH_TOKEN` | *(required)* | Shared secret for REST and WebSocket auth |
| `PORT` | `3030` | Listening port |
| `AGENT_BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `AGENT_BRIDGE_WORKSPACE` | `process.cwd()` | Root boundary for execution targets |
| `AGENT_BRIDGE_ROOT` | `process.cwd()` | Session/task state directory |
| `AGENT_BRIDGE_ALLOWED_ORIGINS` | localhost only | Comma-separated CORS allowlist |

### HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Gateway and running-task summary |
| `GET` | `/api/projects` | Workspace projects |
| `GET` | `/api/capabilities` | Registered adapters and capabilities |
| `GET` | `/api/sessions` | List sessions |
| `GET` | `/api/tasks`, `/api/tasks/:id` | List / inspect tasks |
| `POST` | `/api/dispatch` | Dispatch a task |
| `POST` | `/api/tasks/:id/cancel` | Cancel a task |
| `POST` | `/api/evidence` | Run the Evidence Gate |
| `POST` | `/api/workflow` | Run a generic workflow |
| `POST` | `/api/review-loop` | Run the compatibility review loop |
| `POST` | `/api/git/commit-push` | Commit and push a repository |
| `WS` | `/ws?token=...` | Stream task/workflow lifecycle events |

Execution endpoints require an explicit `cwd` or `project`, and every resolved path must stay inside `AGENT_BRIDGE_WORKSPACE`.

Example generic workflow request:

```json
{
  "project": "my-app",
  "input": "Implement the requested feature and verify it.",
  "workflow": {
    "steps": [
      {
        "type": "agent",
        "role": "implementer",
        "requires": ["fileTools", "shellTools", "sessions"],
        "prompt": "{{input}}"
      },
      {
        "type": "evidence",
        "role": "verifier",
        "testCommands": ["npm test", "npm run typecheck"]
      },
      {
        "type": "agent",
        "role": "reviewer",
        "agent": "claude",
        "prompt": "Review the implementation. Evidence: {{evidenceSummary}}\nDiff:\n{{gitDiff}}"
      }
    ]
  }
}
```

## Evidence and review safety

Evidence verification is fail-closed. A reviewer cannot turn a failed or missing Evidence Gate into PASS merely by writing the word `PASS`. Review verdict parsing only accepts a verdict at the beginning of the first non-empty line.

Git commit and push results are tracked separately; a successful local commit with a failed push is reported as failure rather than success.

## Security

This is a **privileged local development daemon**. Built-in unattended CLI adapters may disable approval/sandbox prompts so they do not hang waiting for input.

In particular:

| Agent | Default unattended behavior |
| --- | --- |
| Codex CLI | `--dangerously-bypass-approvals-and-sandbox` |
| Antigravity | `--dangerously-skip-permissions` |

Treat possession of the gateway token as equivalent to powerful local development access.

- Keep the default bind address at `127.0.0.1` unless you fully trust the network.
- Prefer the Authorization header over query-string tokens because query strings may be logged.
- All execution paths are constrained to `AGENT_BRIDGE_WORKSPACE`, but agents still execute with the privileges of the OS user running Agent Bridge.
- `/api/git/commit-push` pushes to the configured repository remote without a second interactive approval.

Do not expose the gateway to an untrusted network or run it under an unnecessarily privileged user.

## Claude SDK status

The old `ClaudeSdkAdapter` used the plain Anthropic Messages API and therefore did not provide Claude Code/agent capabilities. That path has been removed. `engine=sdk` for Claude remains intentionally unavailable until a real Claude Agent SDK adapter is implemented.

## Development and verification

```bash
npm install
npm run typecheck
npm run build
npm run test:hardening
```

CI runs typecheck, build, and hardening integration tests. A separate live E2E script validates real authenticated Claude/Codex/Antigravity session continuity when those CLIs are installed locally:

```bash
npm run test:agents:e2e
```

## License

MIT
