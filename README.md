# Code 13 desktop prototype

Code 13 is a Windows-first local agent workspace for one selected developer project. The app is implemented with Electron, plain JavaScript, and Electron's Node runtime; task history, agents, schedules, approvals, tickets, and activity events use the built-in SQLite module.

## Run from source

Requirements: Windows, Node.js 24 or newer, and npm.

```powershell
npm install
npm start
```

Open **Settings → Providers**, add an Ollama model or configure an OpenAI/Anthropic/FreeLLM provider, then choose a project folder. A route using Ollama is local. Hosted agent routes identify the provider before you approve them.

## Build for Windows

```powershell
npm run pack:win
```

The portable app folder is written to `release/win-unpacked`. To create an NSIS installer, run `npm run dist:win` (produces `release/Code13-Setup-0.1.0.exe`).

## Model providers

- **Ollama (local)** — default at `http://localhost:11434`. `qwen2.5-coder:7b` is the recommended model; it produces more reliable structured tool output than small general models.
- **OpenAI API** — hosted; keys stored in Windows secure storage.
- **Anthropic API** — hosted; keys stored in Windows secure storage.
- **FreeLLM (local router)** — connects to the separate open-source [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) router on this machine (default `http://localhost:3001/v1`). Install it, add free provider keys (Google, Groq, and others) on its dashboard, then paste the unified key into Code 13. Requests go to your local router, which forwards to free hosted model tiers.

## What works

- One chat entry point with a local route proposal and a visible agent workspace.
- Planner, Builder, and Reviewer presets plus editable custom agents (rename freely).
- **Ticket board.** When you approve a route, Code 13 opens numbered tickets (`T-1`, `T-2`, …), one per planned step. Agents mark tickets `doing`/`done`, create new tickets, and hand work to each other. The board updates live.
- **Handoffs.** A finishing agent can create a ticket and assign it to another agent, which then runs automatically (`assign_ticket` / `create_ticket`).
- **Ask me inbox.** When an agent needs a human decision it posts a question (`ask_user`); you answer with free text and the agent continues.
- **Circuit breaker.** A per-task model-call budget (Settings → Providers, default 40) pauses a task as **Needs attention** before it overspends.
- **Institutional memory.** Completed work is recorded per agent and surfaced to the whole team in later runs.
- Workspace file listing/reading, Git status/diff, and explicit approval for each file write and PowerShell command.
- Local SQLite event history, Windows secure storage for provider credentials, and editable agent memory notes.
- Recurring read-only checks while the app is open. Writes and commands stay in a durable approval queue.
- Provider errors are shown directly; Code 13 does not silently switch providers.
- If a restart interrupts a worker while an approval or question is pending, it survives and can still be handled. Afterward the task is marked **Needs attention** with a message to start a new task; the interrupted model run does not resume automatically.
- **Cancellation takes effect immediately.** Cancelling a task aborts the in-flight model request, not just the next step.
- **Approving a route is idempotent.** A repeated approval (for example, a double click) is ignored instead of starting a second orchestration loop.
- **High-risk shell commands need a second confirmation.** Destructive commands (recursive/forced deletes, `git reset --hard`, `git push --force`, disk formatting, remote-download-and-execute, registry or permission changes) are labelled `HIGH RISK` and their Approve button stays disabled until you tick the confirmation.

## Safety behavior and current limits

- Common `.env`, private-key, and credential-named files (including `.npmrc`, `.pypirc`, `.terraformrc`, `.pgpass`, `.pfx`/`.p12`/`.jks` keystores, `.netrc`, and `~/.aws`, `~/.docker`, `~/.kube` config files) cannot be sent to an agent or changed by an agent.
- VCS and credential-store internals (`.git/`, `.ssh/`, `.gnupg/`, `.aws/`, `.kube/`, `.docker/`) are blocked for both reads and writes, so an agent cannot exfiltrate a token from `.git/config` or plant a `.git/hooks/*` script.
- `git_diff` applies the same secret policy: a diff of a named secret file is refused, and a whole-tree diff first lists changed files and excludes any secret paths before asking Git for content.
- Workspace traversal and symbolic-link paths are blocked. File browsing skips dependency and build folders.
- `run_shell` is a real boundary, not a sandbox: an approved command runs in the project folder as your user. Code 13 warns before obviously destructive commands and always requires approval, but it cannot undo what you approve.
- Agent runs are sequential in this prototype. A worker can request up to eight tool steps.
- Routing is local keyword matching, or an optional Ollama plan when an Ollama model is configured. Choosing a hosted task provider does not send the request during route preparation; hosted execution begins after route approval.
- Schedules run only while Code 13 is open. If a scheduled agent requests a write or shell command, Code 13 queues it for approval.
- The model parser accepts common small-model shorthand (for example `{"type":"git_status"}`), but a very small local model may still spend a few turns before producing a well-formed tool call.
- A tool call that is blocked or fails (for example a refused secret file or an unknown ticket) is reported back to the agent as a recoverable error and the run continues, so the agent can correct course. Cancelling a task also clears any approval or question it was waiting on, so a suspended worker never lingers.

## Development

The main process is split into focused modules under `src/lib/`: `db.js` (SQLite schema and seeding), `model.js` (provider I/O), `git.js`/`shell.js`/`workspace.js` (project tools), `prompts.js` (agent prompt text), `constants.js` (providers, presets, labels), and `policy.js` (path, secret, and shell-risk policy). `src/main.js` wires IPC, orchestration, and the scheduler.

```powershell
npm test          # node:test suite
npm run lint      # ESLint
npm run format    # Prettier (opt-in; the shipped files use a compact style)
```

## Tests

```powershell
npm test
```

The test suite covers provider streams and errors, FreeLLM routing, route/privacy behavior, workspace path checks, approved file writes and shell commands, restart-persistent approvals, Builder/Reviewer sequencing, ticket creation, agent handoffs, the Ask-me round trip, the circuit breaker, restart-persistent questions, model-output parsing, secret-file and VCS-internal policy (including `git_diff` filtering and token redaction), recoverable tool errors, cancelling a task that is awaiting approval, shell-risk assessment, scheduled read-only permissions, and the extracted Git/shell/workspace tool modules.
