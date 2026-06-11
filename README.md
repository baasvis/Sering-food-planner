# note-voice-mcp

Capture voice and text notes on your phone, and let Claude (cowork / claude.ai)
read and process them through a remote MCP server.

```
Pixel (tap back ×2) ──► Voice Notes PWA ──► POST /api/notes ──► Postgres
                         (on-device Google                        │
                          speech recognition,                     ▼
                          free, no API keys)         Claude cowork ◄── MCP /mcp/<secret>
                                                     (list_notes, search_notes,
                                                      add_note, mark_processed)
```

- **No transcription API costs** — speech-to-text happens on the phone via the
  Web Speech API (Chrome's built-in Google recognition). Only the final text is
  sent to the server.
- **One small server** — Express + TypeScript. Serves the PWA, a tiny notes
  API, and a stateless streamable-HTTP MCP endpoint.
- **Storage** — Postgres when `DATABASE_URL` is set (Railway plugin), JSON file
  fallback (`./data/notes.json`) for local development.

## MCP tools

| Tool | What it does |
|---|---|
| `list_notes` | List notes, newest first (default: only unprocessed "inbox" notes) |
| `get_note` | Fetch one note by id |
| `search_notes` | Substring search across all notes |
| `add_note` | Let Claude write a note back into the inbox |
| `mark_processed` | Archive notes after Claude has acted on them |

A good cowork habit: start a session with *"check my notes"* — Claude calls
`list_notes`, works through them, and `mark_processed` clears the inbox.

## Setup

### 1. Deploy (Railway)

1. Push this repo to GitHub and create a new Railway project **from the repo**
   (auto-deploys on push to `main`).
2. Add the **PostgreSQL plugin** and reference its `DATABASE_URL` in the
   service variables.
3. Set `NOTES_SECRET` (generate with `openssl rand -hex 24`). Without it the
   server runs **unprotected** — fine locally, never in production.
4. Railway sets `PORT` itself. Build/start commands are picked up from
   `package.json` (`npm run build` / `npm start`).

### 2. Phone (Google Pixel)

1. In Chrome on the Pixel, open `https://<your-app>.up.railway.app/?key=<NOTES_SECRET>`
   — the key is stored in the browser's localStorage; you only do this once.
2. Tap the mic once and **allow microphone access**.
3. Chrome menu (⋮) → **Add to Home screen → Install** to install the PWA.
4. **Quick Tap (tap back twice):** Settings → **System → Gestures → Quick Tap**
   → turn on → **Open app** → pick **Voice Notes**.

Now double-tapping the back of the phone opens the app, which immediately
starts listening (`start_url` is `/?autostart=1`). Talk, tap ⏹, done — the
note is saved. There's also a ⌨️ text mode, an NL/EN language toggle, and the
app is a **share target**: share text from any app (e.g. a Pixel Recorder
transcript) straight into the inbox.

If saving fails offline, notes are queued in localStorage and synced on the
next launch / when back online.

### 3. Claude (cowork / claude.ai)

Add a custom connector pointing at the MCP endpoint with the secret in the
path (claude.ai connectors can't set custom headers):

> Settings → Connectors → **Add custom connector** →
> `https://<your-app>.up.railway.app/mcp/<NOTES_SECRET>`

Then enable the connector in cowork. Clients that *can* send headers (Claude
Code, etc.) can use `https://<your-app>.up.railway.app/mcp` with
`Authorization: Bearer <NOTES_SECRET>` instead.

Claude Code example (`.mcp.json` / `claude mcp add`):

```bash
claude mcp add --transport http voice-notes \
  https://<your-app>.up.railway.app/mcp \
  --header "Authorization: Bearer <NOTES_SECRET>"
```

## Local development

```bash
npm install
npm run icons      # regenerate PWA icons (already committed)
npm run dev        # tsx watch on :3000, JSON-file store, no auth unless NOTES_SECRET set
```

- PWA: http://localhost:3000/
- Health: `GET /healthz`
- Notes API: `GET/POST /api/notes`, `POST /api/notes/:id/processed`,
  `DELETE /api/notes/:id` — auth via `Authorization: Bearer`, `x-api-key`, or `?key=`
- MCP: `POST /mcp` (or `/mcp/<secret>`), stateless streamable HTTP

Quick MCP smoke test:

```bash
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Security notes

- One shared secret (`NOTES_SECRET`) protects both the notes API and the MCP
  endpoint. The claude.ai connector embeds it in the URL — treat that URL as a
  credential and rotate the secret if it leaks (just change the env var).
- The PWA shell (HTML/JS/icons) is public; all note data requires the key.
- Speech recognition uses Chrome's Google speech service — audio is processed
  by Google, only text reaches this server.
