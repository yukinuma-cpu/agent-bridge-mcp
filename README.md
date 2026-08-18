# agent-bridge-mcp

An MCP server and HTTP gateway that dispatches coding tasks to **Claude Code**,
**Codex**, and **Antigravity (`agy`)** CLI sessions, keeps track of those sessions,
and optionally runs an implement → review → verify loop against a real repository.

> **Status: experimental.** This started as a personal orchestration rig and is
> published in the hope that the session-routing and evidence-gate parts are
> useful to others. Interfaces will change.

## What it does

- **Session routing** — starts and resumes Claude Code / Codex sessions per project
  and topic, so follow-up prompts land in the same context.
- **Task tracking** — every dispatch becomes a task with status, output, and exit code.
- **Evidence gate** — runs the test commands you specify in a repository and reports
  whether the change is actually backed by passing tests before you accept it.
- **Review loop** — dispatches an implementer agent and a reviewer agent in turn,
  up to a revision limit, gated on the evidence check.
- **Gateway** — the same capabilities over HTTP + WebSocket, so a remote client
  (for example a phone) can dispatch work and stream output.

## Install

```bash
npm install -g @yukinuma/agent-bridge-mcp
```

Requires Node.js 20+, plus whichever agent CLIs you intend to drive
(`claude`, `codex`, and/or `agy`) already installed and authenticated.

### A note on the `antigravity` agent

`agy` runs an internal language server and expects a real terminal. Started from an
ordinary pipe it shuts down before it answers, which from the caller's side is
indistinguishable from a hang. On Windows this adapter therefore runs it under
`winpty` (bundled with Git for Windows) and keeps stdin open for the duration of
the call.

Two consequences worth knowing:

- `winpty` aborts on its own assertion while tearing down, so its exit code does not
  reflect what `agy` did. When running through a pty the adapter judges success by
  whether a response came back, not by the exit code, and filters the assertion text
  out of the captured output.
- On timeout the process tree is killed by PID. Killing by image name would take out
  any interactive `agy` you have open elsewhere, so that is deliberately not done.

Set `WINPTY_PATH` or `AGY_PATH` if either binary is somewhere non-standard. On
non-Windows platforms `agy` is launched directly, which is untested.

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

Tools exposed: `agent_send`, `agent_status`, `agent_sessions`, `agent_cancel`.

## Use as a gateway

```bash
export ABC_AUTH_TOKEN="$(openssl rand -hex 24)"
export AGENT_BRIDGE_WORKSPACE="/path/to/your/projects"
agent-bridge-gateway
```

The gateway **refuses to start without `ABC_AUTH_TOKEN`**. There is no default token.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ABC_AUTH_TOKEN` | *(required)* | Shared secret for REST and WebSocket auth |
| `PORT` | `3030` | Listening port |
| `AGENT_BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `AGENT_BRIDGE_WORKSPACE` | `process.cwd()` | Base directory that `project` names resolve against |
| `AGENT_BRIDGE_ROOT` | `process.cwd()` | Where session and task state files are written |
| `AGENT_BRIDGE_ALLOWED_ORIGINS` | localhost only | Comma-separated CORS allowlist |

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/status` | Gateway and running-task summary |
| `GET` | `/api/projects` | Directories found under the workspace |
| `GET` | `/api/sessions` | List sessions |
| `GET` | `/api/tasks`, `/api/tasks/:id` | List / inspect tasks |
| `POST` | `/api/dispatch` | Dispatch a task to an agent |
| `POST` | `/api/tasks/:id/cancel` | Cancel a running task |
| `POST` | `/api/evidence` | Run the evidence gate |
| `POST` | `/api/git/commit-push` | Commit and push a repository |
| `POST` | `/api/review-loop` | Run the implement/review loop |
| `WS` | `/ws?token=…` | Task output and lifecycle events |

`/api/dispatch`, `/api/git/commit-push`, and `/api/review-loop` require an explicit
target — either `cwd`, or a `project` that resolves inside the workspace. They return
`400` rather than falling back to a default directory, and `project` values that
escape the workspace are rejected.

## Security

This service executes agent CLIs and can commit and push git repositories. Treat it
as a privileged local daemon:

- It binds to `127.0.0.1` by default. Setting `AGENT_BRIDGE_HOST` to anything else
  exposes task dispatch and git push to your network.
- The auth token is a single shared secret, sent as a bearer header or a `token`
  query parameter. Query parameters end up in logs — prefer the header where you can.
- There is no sandboxing between projects beyond the workspace path check.

Do not expose this to an untrusted network.

## Development

```bash
npm install
npm run typecheck
npm run build
```

## License

MIT
