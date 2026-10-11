# Connect the free LLMs (FreeLLMAPI) to Code 13

Code 13 talks to **FreeLLMAPI**, a separate open-source local router that fans out
to many free hosted model tiers (Google AI Studio, Groq, Cerebras, and others)
behind **one OpenAI-compatible endpoint**. Code 13 never sees the individual
provider keys — it sends requests to your local router, which forwards them.

- Project: <https://github.com/tashfeenahmed/freellmapi>
- Default router address: `http://localhost:3001` (API base `http://localhost:3001/v1`)

## 1. Install and run the router

1. Download and install FreeLLMAPI for Windows.
2. Start it and confirm the dashboard opens at <http://localhost:3001>.
3. Keep it running whenever you use Code 13 with the FreeLLM provider.

## 2. Add free provider keys inside FreeLLMAPI

1. In the dashboard, open the **Keys** tab.
2. Add a key for each free tier you want to use (Google AI Studio, Groq, Cerebras, …).
3. Reorder the **fallback chain** so the router knows which provider to try first.
4. Copy the **unified key** shown in the dashboard (it starts with `freellmapi-`).
   Code 13 only needs this one key.

## 3. Point Code 13 at the router

1. In Code 13, open **Settings → Providers**.
2. Find the **FreeLLM · local router** card.
3. Set **API base URL** to `http://localhost:3001/v1`.
4. Paste the **unified key** into the key field.
5. Click **Check router** — you should see "Router reachable · N models".
6. Click **Load models**, then pick a model (the first one is chosen for you if the
   field is empty). Example ids look like `google/gemini-2.0-flash-001:free`.
7. Click **Save settings**.

## 4. Run a task

Type a request in the chat box, choose **FreeLLM · local router** in the
"ROUTE WITH" selector, then pick a model from the **MODEL** selector next to it
(click **⟳** to reload the list). Code 13 auto-loads the model list when you
switch to FreeLLM, and if no model is chosen it falls back to the first offered
model — or `auto` — so a task can always start. Send, approve the proposed
route, then watch the conversation and activity feed.

## Troubleshooting

| Symptom | Meaning | Fix |
| --- | --- | --- |
| "FreeLLMAPI router not reachable at http://localhost:3001/v1" | The router app is not running (port 3001 is closed). | Start FreeLLMAPI and click **Check router** again. |
| "The unified key was rejected" | The key is wrong or stale. | Copy a fresh unified key from the FreeLLMAPI dashboard and save it in Settings. |
| "Add a model" / "Choose a model for …" | No model is selected for the provider. | Pick one in the composer's **MODEL** selector, or click **Load models** in Settings and Save. |
| "FreeLLMAPI could not reach any upstream provider" | The router is up but has no working provider keys / fallback chain. | Add or fix provider keys and reorder the fallback chain in the FreeLLMAPI dashboard. |
| "That model may not exist" | The model id is not offered by the router. | Click **Load models** and choose an id from the list. |
| Model dropdown is empty after **Load models** | The router is reachable but returned no models, or the key lacks access. | Verify provider keys in the dashboard and the unified key in Settings. |

## Notes

- Ollama (local) needs no key and always works offline. FreeLLM requires the
  router process to stay running.
- Code 13 shows connection problems as plain-language messages and never
  silently switches providers.
