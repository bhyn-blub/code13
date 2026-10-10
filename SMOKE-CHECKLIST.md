# Code 13 GUI Smoke-Test Checklist

**Prerequisite:** Open `release\win-unpacked\Code 13.exe`. Have a disposable Git project folder ready. Ollama is running with `qwen2.5-coder:7b`.

---

## A. First-run & providers
1. App opens to the first-run screen (empty workspace, Planner/Builder/Reviewer cards, "Ollama · local" pill).
2. Click **⚙ Settings → Providers**. Confirm four cards: Ollama, OpenAI, Anthropic, **FreeLLM · local router**.
3. In the Ollama card, type `qwen2.5-coder:7b` in the **Model** field.
4. Click **Save settings** (the button highlights when you have unsaved changes). Confirm "Settings saved locally."
5. Click **Test connection** → expect "Connected · N models".
6. Go to **Workspace** tab → **Choose folder** → pick your disposable Git project.
7. Confirm the folder name appears in the sidebar, top bar, composer, AND the Workspace tab updates immediately (no need to close/reopen).

## B. Route proposal + ticket board
8. In the composer, type: `Read the README and summarise the project.` → send.
9. A **route panel** appears showing the proposed agent(s), a privacy label, and a **"Tickets opened when you approve"** list (T-1, T-2…).
10. Click **Approve route**.
11. Watch the right column: the **Ticket board** shows the tickets, and an agent card flips to **"Working on T-1"** with a pulsing dot.

## C. Read-only run
12. The agent calls `list_files` / `read_file` / `git_status` (visible as activity items). No approval needed for these.
13. A final summary appears in the chat; the ticket flips to **done**; task completes.

## D. Ask-me inbox
14. New task: `Build a small feature and review it.` → approve.
15. If the agent posts an **"Ask me"** card (purple, "REQUIRES YOU"), type an answer and click **Send answer**. The agent should continue.
16. If no question appears, note it and move on (small models may not always ask).

## E. File-write approval
17. New task: `Create a file called notes.txt with a short summary.` → approve.
18. When the agent requests a write, an **approval card** shows the file path + proposed contents. Confirm the file does **not** exist yet.
19. Click **Approve action** → the file appears in your project folder.
20. On a later write, click **Reject** → confirm the file does **not** appear.

## F. Shell-command approval
21. New task: `Run git status and tell me the result.` → approve.
22. When the agent requests `run_shell`, the approval card shows the exact command + working directory. Confirm it does **not** run before approval.
23. Approve → confirm the command output appears in the chat.
24. New task: ask for a destructive command (e.g. `Remove-Item -Recurse -Force .\out`). Confirm the card is marked **HIGH RISK**, the **Approve action** button is disabled, and ticking the confirmation enables it.

## G. Cancel
25. Start a task and, while an agent is running, cancel it. The task should move to **cancelled** promptly (the in-flight model request is aborted, not just the next step).
26. Start a task that reaches a write or shell approval, then click **Cancel** while the approval card is showing. The task should move to **cancelled** and the approval card should disappear; no command runs.

## G2. Recoverable tool errors
27. New task: `Show me the diff of the .env file.` → approve. The agent's `git_diff` is refused, an activity item flags the tool error, and the run continues to a final report instead of failing.
28. New task: ask the agent to update a ticket that does not exist (small models often try `T-1` before tickets exist). Confirm a tool error is shown and the agent can still finish.

## H. Restart persistence
29. Start a task that will request a write. While the approval card is showing, **close the app**.
30. Reopen the app. The pending approval should still be listed.
31. Approve it → the task shows **"Needs attention"** with a message that a new task is needed (it must **not** claim the interrupted task completed).

## I. FreeLLM (if FreeLLMAPI is installed)
32. Settings → Providers → FreeLLM card → paste the unified key → **Save settings** → **Test connection**.
33. Run a read-only task routed through FreeLLM and confirm it works.

---

## What to watch for
- Does the ticket board update live, or only after refresh?
- Does the Ask-me answer actually reach the agent?
- Does the budget pause trigger if you set it to 5 in Settings?
- Do tool errors render with a clear label (⚠) instead of a bare `tool-error` string?
- Any console errors (toggle with **Ctrl+Shift+I** in the app)?

## Report format
For each step: ✅ works / ❌ broken (with what you saw) / ⚠️ odd.
