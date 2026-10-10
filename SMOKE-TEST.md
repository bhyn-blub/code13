# Code 13 Windows smoke-test results

## Verified in this session (2026-10-10)

- **Unit/coordinator tests:** `npm test` → **23 passed, 0 failed, 0 skipped**. Coverage includes route-before-hosted-call, approved file write, approved shell command, restart-persistent approval, ticket board creation, agent handoff, Ask-me round trip, circuit breaker, restart-persistent question, FreeLLM streaming/auth, and model-output parsing.
- **JavaScript syntax checks** passed for the main process, renderer, preload, and all `src/lib` modules.
- **Portable build:** `npm run pack:win` rebuilt `release/win-unpacked/Code 13.exe` (213 MB) successfully.
- **NSIS installer build:** `npm run dist:win` **succeeded**, producing `release/Code13-Setup-0.1.0.exe` (93 MB). The earlier `makensis.exe` spawn failure did not reproduce in this environment.
- **Installer install/launch/uninstall:** a silent per-user install to a temp folder exited 0, wrote `Code 13.exe` and an uninstaller, launched and ran for 12 seconds with no crash, and then uninstalled cleanly.
- **App boot from source:** `electron .` launched and stayed alive (main + renderer + GPU + utility processes) with no crash.
- **Live Ollama verification** (model `qwen2.5-coder:7b`, reachable at `127.0.0.1:11434`):
  - Route planning returned valid JSON (`{"agents":["planner"], ...}`), parsed correctly including the ```json fence.
  - A worker turn produced the strict tool schema `{"type":"tool","name":"list_files","arguments":{"path":"."}}`, parsed and normalized correctly.
  - A shorthand variant `{"type":"git_status"}` observed on a complex prompt is now rescued by `normalizeToolCall`, so small local models stay usable.

## Requires a human at the desktop UI (not automated here)

- Clicking through the folder picker and confirming real workspace selection.
- Visually confirming the ticket board, Ask-me inbox, route ticket preview, and agent "working on T-n" states during a live run.
- Approving a real file write and a real shell command from the GUI.
- Confirming approval/question persistence by restarting the GUI mid-flow.

## Environment notes

- Ollama is reachable on this machine, so live local-model runs were verified. On a machine that blocks `127.0.0.1:11434`, live runs cannot be verified.
- Rust, Cargo, and MSVC's `cl.exe` are unavailable, so the Tauri comparison and weighted shell score remain pending (see FRAMEWORK-SPIKE.md).

## Next hands-on check

Open the installed app or `release/win-unpacked/Code 13.exe`, select a disposable Git project, connect `qwen2.5-coder:7b` (or FreeLLM), and complete one read-only task plus one approved edit and command, watching the ticket board and answering any Ask-me question. Then restart mid-approval to confirm persistence.
