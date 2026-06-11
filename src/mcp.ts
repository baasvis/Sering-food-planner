import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Note, NoteStore } from "./store.js";

function noteForModel(n: Note) {
  return {
    id: n.id,
    created_at: n.createdAt,
    kind: n.kind,
    lang: n.lang,
    source: n.source,
    status: n.status,
    text: n.text,
  };
}

function asTextResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Builds a fresh MCP server instance. The streamable-HTTP endpoint runs in
 * stateless mode, so one of these is created per incoming request.
 */
export function buildMcpServer(store: NoteStore): McpServer {
  const server = new McpServer({
    name: "voice-notes",
    version: "0.1.0",
  });

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List captured voice/text notes, newest first. By default returns only " +
        "'inbox' notes (not yet processed). Call this at the start of a session " +
        "to see what the user has captured since last time.",
      inputSchema: {
        status: z
          .enum(["inbox", "processed", "all"])
          .optional()
          .describe("Which notes to return (default: inbox)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max notes (default 50)"),
      },
    },
    async ({ status, limit }) => {
      const notes = await store.list({ status, limit });
      return asTextResult({ count: notes.length, notes: notes.map(noteForModel) });
    },
  );

  server.registerTool(
    "get_note",
    {
      title: "Get a note",
      description: "Fetch a single note by its id, including full text.",
      inputSchema: { id: z.string().describe("Note id") },
    },
    async ({ id }) => {
      const note = await store.get(id);
      if (!note) return asTextResult({ error: `No note with id ${id}` });
      return asTextResult(noteForModel(note));
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Case-insensitive substring search across all notes (inbox and processed). " +
        "Use this when looking for a note about a specific topic.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for"),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      },
    },
    async ({ query, limit }) => {
      const notes = await store.search(query, limit);
      return asTextResult({ count: notes.length, notes: notes.map(noteForModel) });
    },
  );

  server.registerTool(
    "add_note",
    {
      title: "Add a note",
      description:
        "Save a new note. Use this to write follow-ups, summaries, or reminders " +
        "back into the user's note inbox.",
      inputSchema: {
        text: z.string().min(1).describe("Note content"),
        source: z.string().optional().describe("Where this note came from (default: claude)"),
      },
    },
    async ({ text, source }) => {
      const note = await store.add({ text, kind: "text", source: source ?? "claude" });
      return asTextResult({ saved: noteForModel(note) });
    },
  );

  server.registerTool(
    "mark_processed",
    {
      title: "Mark notes processed",
      description:
        "Mark one or more notes as processed so they leave the inbox. Call this " +
        "after you have acted on a note (created the task, answered the question, etc.).",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("Note ids to mark as processed"),
      },
    },
    async ({ ids }) => {
      const updated = await store.markProcessed(ids);
      return asTextResult({ updated });
    },
  );

  return server;
}
