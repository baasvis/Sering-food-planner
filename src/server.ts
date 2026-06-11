import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { createStore, PgStore } from "./store.js";
import type { NoteKind } from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);
const SECRET = process.env.NOTES_SECRET ?? "";

if (!SECRET) {
  console.warn(
    "[auth] NOTES_SECRET is not set — the API and MCP endpoint are UNPROTECTED. " +
      "Fine locally, never in production.",
  );
}

const store = createStore();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function extractKey(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xk = req.headers["x-api-key"];
  if (typeof xk === "string") return xk;
  if (typeof req.params.key === "string") return req.params.key;
  if (typeof req.query.key === "string") return req.query.key;
  return null;
}

function isAuthorized(req: Request): boolean {
  if (!SECRET) return true; // dev mode
  const key = extractKey(req);
  return key !== null && safeEqual(key, SECRET);
}

function requireKey(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// PWA shell (HTML/JS/manifest/icons) is public; all data goes through the
// key-protected API below.
app.use(express.static(path.resolve("public")));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, store: store instanceof PgStore ? "postgres" : "file" });
});

// ---------------------------------------------------------------------------
// Notes API (used by the PWA)
// ---------------------------------------------------------------------------

const VALID_KINDS: NoteKind[] = ["voice", "text", "shared"];

app.get("/api/notes", requireKey, async (req, res) => {
  const status =
    req.query.status === "processed" || req.query.status === "all"
      ? req.query.status
      : "inbox";
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
  const notes = await store.list({ status, limit });
  res.json({ notes });
});

app.post("/api/notes", requireKey, async (req, res) => {
  const { text, kind, lang, source } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const note = await store.add({
    text: text.trim(),
    kind: VALID_KINDS.includes(kind as NoteKind) ? (kind as NoteKind) : "text",
    lang: typeof lang === "string" ? lang : null,
    source: typeof source === "string" ? source : "pwa",
  });
  res.status(201).json({ note });
});

app.post("/api/notes/:id/processed", requireKey, async (req, res) => {
  const updated = await store.markProcessed([String(req.params.id)]);
  res.json({ updated });
});

app.delete("/api/notes/:id", requireKey, async (req, res) => {
  const deleted = await store.delete(String(req.params.id));
  res.status(deleted ? 200 : 404).json({ deleted });
});

// ---------------------------------------------------------------------------
// MCP endpoint (Claude cowork / claude.ai custom connector)
//
// Stateless streamable HTTP: a fresh server + transport per request.
// Auth: either `Authorization: Bearer <secret>` on /mcp, or the secret
// embedded in the path (/mcp/<secret>) for clients that can't set headers.
// ---------------------------------------------------------------------------

async function handleMcp(req: Request, res: Response): Promise<void> {
  if (!isAuthorized(req)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  const server = buildMcpServer(store);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", handleMcp);
app.post("/mcp/:key", handleMcp);

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
}
app.get(["/mcp", "/mcp/:key"], methodNotAllowed);
app.delete(["/mcp", "/mcp/:key"], methodNotAllowed);

// ---------------------------------------------------------------------------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal error";
  console.error("[error]", message);
  if (!res.headersSent) res.status(500).json({ error: message });
});

await store.init();
app.listen(PORT, () => {
  console.log(`note-voice-mcp listening on :${PORT}`);
  console.log(`  PWA:  http://localhost:${PORT}/`);
  console.log(`  MCP:  http://localhost:${PORT}/mcp`);
});
