# Handover: finish setting up `note-voice-mcp`

You are picking up a finished, tested codebase. Your job is deployment and
wiring, not development. Work through the tasks in order; each has a
verification step — don't mark a task done until its check passes.

## What this is

A voice/text notes pipeline: Daan double-taps the back of his Pixel → a PWA
opens and transcribes speech on-device (Web Speech API, Dutch default) → notes
land in a small Express/TypeScript server → Claude reads them through a remote
MCP endpoint (`/mcp/<secret>`) with tools `list_notes`, `get_note`,
`search_notes`, `add_note`, `mark_processed`.

## Current state (verified)

- All code lives on branch **`claude/note-voice-mcp-ridjrm`** of
  `baasvis/Sering-food-planner`. It is an **orphan branch** — a complete,
  standalone project with no food-planner files or history.
- `npm run typecheck` and `npm run build` pass. The server was smoke-tested
  end-to-end: auth returns 401 without the key; notes save/list via
  `/api/notes`; the MCP endpoint completes `initialize` → `tools/list` →
  `tools/call list_notes`.
- Storage: Postgres when `DATABASE_URL` is set, JSON-file fallback otherwise.
- Nothing is deployed yet, and the code is not in its own repository yet.

## Hard rules

- **Never merge `claude/note-voice-mcp-ridjrm` into the food-planner's
  `main`** and never open a PR for it there. It's an orphan branch only
  parked in that repo.
- Treat `NOTES_SECRET` as a credential. Don't paste it into commit messages,
  PR text, or logs. The claude.ai connector URL will contain it — that's by
  design; never write that URL anywhere public.
- Don't refactor or "improve" the code while deploying. If something blocks
  deployment, make the smallest fix and note it.

---

## Task 1 — Move the code into its own repository

Create a **private** GitHub repo `baasvis/note-voice-mcp` (no README, no
.gitignore — it must be empty), then:

```bash
git clone --branch claude/note-voice-mcp-ridjrm \
  https://github.com/baasvis/Sering-food-planner note-voice-mcp
cd note-voice-mcp
git remote set-url origin https://github.com/baasvis/note-voice-mcp
git push -u origin claude/note-voice-mcp-ridjrm:main
```

If you can't push over git (no credentials in your environment), fall back to
the GitHub API: create the repo, then upload the 16 files from the branch via
the contents API (base64 for the two PNG icons). Ask Daan for a token only if
neither path works.

**Verify:** `https://github.com/baasvis/note-voice-mcp` shows `README.md`,
`src/`, `public/` on `main`.

Optional cleanup afterwards: delete branch `claude/note-voice-mcp-ridjrm`
from the food-planner repo (only after the new repo verifiably has the code).

## Task 2 — Generate the secret

```bash
openssl rand -hex 24
```

Save it for tasks 3 and 4, and give it to Daan at the end labeled
`NOTES_SECRET`.

## Task 3 — Deploy on Railway

Daan already uses Railway (the food planner runs there), so he's logged in.
Use the browser (railway.app) — or the Railway CLI if a `RAILWAY_TOKEN` is
available.

1. New Project → **Deploy from GitHub repo** → `baasvis/note-voice-mcp`.
2. Add the **PostgreSQL** database plugin to the project.
3. On the service → Variables:
   - `NOTES_SECRET` = the value from task 2
   - `DATABASE_URL` = reference the Postgres plugin's variable
     (`${{Postgres.DATABASE_URL}}`)
4. Build/start need no configuration (Nixpacks picks up `npm run build` /
   `npm start` from package.json). Node ≥ 20 is required (`engines` is set).
5. Settings → Networking → **Generate Domain**. Note the URL
   (`https://<app>.up.railway.app`).

**Verify:**

```bash
curl https://<app>.up.railway.app/healthz
# expect: {"ok":true,"store":"postgres"}   ← "postgres", NOT "file"
```

If it says `"file"`, `DATABASE_URL` isn't wired — fix the variable reference
and redeploy.

## Task 4 — Verify the MCP endpoint live

```bash
curl -s https://<app>.up.railway.app/mcp/<NOTES_SECRET> \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect a JSON-RPC result listing 5 tools. Also confirm a wrong secret gets
401:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  https://<app>.up.railway.app/mcp/wrong -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# expect: 401
```

Optionally seed one test note so the first phone sync isn't empty:

```bash
curl -s -X POST https://<app>.up.railway.app/api/notes \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <NOTES_SECRET>" \
  -d '{"text":"Test note from setup — delete me","kind":"text","source":"setup"}'
```

## Task 5 — Hand the human steps back to Daan

These cannot be done by you — finish by giving Daan this exact checklist with
the real URL and secret filled in:

1. **Connector** (claude.ai → Settings → Connectors → Add custom connector):
   `https://<app>.up.railway.app/mcp/<NOTES_SECRET>` — then enable it in
   cowork.
2. **Pixel install**: open
   `https://<app>.up.railway.app/?key=<NOTES_SECRET>` in Chrome on the
   phone (once — the key is then stored locally), tap the mic and **allow
   microphone access**, then Chrome ⋮ → *Add to Home screen → Install*.
3. **Quick Tap**: Settings → System → Gestures → **Quick Tap** → on →
   *Open app* → **Voice Notes**.
4. Test: double-tap the back of the phone, speak a note, tap ⏹, then ask
   Claude (with the connector enabled) to "check my notes".

## Reference

| Thing | Value |
|---|---|
| Endpoints | `/` (PWA), `/healthz`, `/api/notes…`, `/mcp` + `/mcp/<secret>` |
| Auth | `Authorization: Bearer`, `x-api-key`, `?key=`, or secret in the `/mcp/…` path |
| Env vars | `NOTES_SECRET` (required in prod), `DATABASE_URL` (Postgres), `PORT` (Railway sets it) |
| MCP transport | Streamable HTTP, stateless, JSON responses |
| Repo docs | `README.md` in the repo covers all of the above in more detail |
