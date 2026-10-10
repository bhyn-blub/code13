# Desktop framework spike

## Result

**Electron is the shell used for this prototype.** The Electron vertical slice packages successfully as a Windows portable app directory at `release/win-unpacked`.

## What was measured

- Electron 41.10.7 and Node.js 24 were available in the workspace.
- The app uses an isolated renderer (`contextIsolation` and `sandbox` enabled; no renderer Node access), a small preload IPC surface, main-process provider calls, Electron secure storage, and built-in SQLite.
- `electron-builder --win dir` completed and produced `release/win-unpacked`.
- `electron-builder --win nsis` completed and produced `release/Code13-Setup-0.1.0.exe`, which was silently installed, launched, and uninstalled successfully in this session.
- The packaged Electron app launched and displayed its first-run workspace screen on Windows.
- Depending on the machine, access to Ollama at `127.0.0.1:11434` may be available or blocked; live local-model connection was verified on this machine with `qwen2.5-coder:7b`.

## Tauri comparison status

The same Tauri build could not be compiled in this environment: `cargo`, `rustc`, and the Windows C++ linker (`cl.exe`) are not installed. Installing a Rust/MSVC toolchain would be necessary for a real Tauri packaging and permission-enforcement comparison. The weighted side-by-side score from the plan is therefore **not claimed**. Electron remains the practical prototype choice because its vertical slice is buildable with the installed Node toolchain. Re-run the weighted comparison on a Windows developer machine with Rust and MSVC available before treating the shell choice as final.

## Remaining comparison checks

When the Tauri toolchain is available, build the same chat, agent-card, Ollama stream, workspace picker, and approved-command slice. Score both implementations using the agreed weights: permission/security (35%), Windows packaging (25%), maintainability (20%), and idle resource use (20%).
