import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

export type NoteKind = "voice" | "text" | "shared";
export type NoteStatus = "inbox" | "processed";

export interface Note {
  id: string;
  createdAt: string; // ISO timestamp
  kind: NoteKind;
  lang: string | null;
  source: string | null;
  text: string;
  status: NoteStatus;
  processedAt: string | null;
}

export interface NewNote {
  text: string;
  kind?: NoteKind;
  lang?: string | null;
  source?: string | null;
}

export interface ListOptions {
  status?: NoteStatus | "all";
  limit?: number;
}

export interface NoteStore {
  init(): Promise<void>;
  add(note: NewNote): Promise<Note>;
  get(id: string): Promise<Note | null>;
  list(opts?: ListOptions): Promise<Note[]>;
  search(query: string, limit?: number): Promise<Note[]>;
  markProcessed(ids: string[]): Promise<number>;
  delete(id: string): Promise<boolean>;
}

const DEFAULT_LIMIT = 50;

function makeNote(input: NewNote): Note {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    kind: input.kind ?? "text",
    lang: input.lang ?? null,
    source: input.source ?? null,
    text: input.text,
    status: "inbox",
    processedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Postgres store (production — Railway Postgres)
// ---------------------------------------------------------------------------

export class PgStore implements NoteStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id           TEXT PRIMARY KEY,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind         TEXT NOT NULL DEFAULT 'text',
        lang         TEXT,
        source       TEXT,
        text         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'inbox',
        processed_at TIMESTAMPTZ
      )
    `);
  }

  private rowToNote(r: Record<string, unknown>): Note {
    return {
      id: r.id as string,
      createdAt: (r.created_at as Date).toISOString(),
      kind: r.kind as NoteKind,
      lang: (r.lang as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      text: r.text as string,
      status: r.status as NoteStatus,
      processedAt: r.processed_at ? (r.processed_at as Date).toISOString() : null,
    };
  }

  async add(input: NewNote): Promise<Note> {
    const n = makeNote(input);
    await this.pool.query(
      `INSERT INTO notes (id, created_at, kind, lang, source, text, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [n.id, n.createdAt, n.kind, n.lang, n.source, n.text, n.status],
    );
    return n;
  }

  async get(id: string): Promise<Note | null> {
    const res = await this.pool.query(`SELECT * FROM notes WHERE id = $1`, [id]);
    return res.rows[0] ? this.rowToNote(res.rows[0]) : null;
  }

  async list(opts: ListOptions = {}): Promise<Note[]> {
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, 200);
    const status = opts.status ?? "inbox";
    const where = status === "all" ? "" : `WHERE status = $2`;
    const params: unknown[] = status === "all" ? [limit] : [limit, status];
    const res = await this.pool.query(
      `SELECT * FROM notes ${where} ORDER BY created_at DESC LIMIT $1`,
      params,
    );
    return res.rows.map((r) => this.rowToNote(r));
  }

  async search(query: string, limit = DEFAULT_LIMIT): Promise<Note[]> {
    const res = await this.pool.query(
      `SELECT * FROM notes WHERE text ILIKE $1 ORDER BY created_at DESC LIMIT $2`,
      [`%${query}%`, Math.min(limit, 200)],
    );
    return res.rows.map((r) => this.rowToNote(r));
  }

  async markProcessed(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.pool.query(
      `UPDATE notes SET status = 'processed', processed_at = now()
       WHERE id = ANY($1) AND status <> 'processed'`,
      [ids],
    );
    return res.rowCount ?? 0;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM notes WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// File store (local development fallback — ./data/notes.json)
// ---------------------------------------------------------------------------

export class FileStore implements NoteStore {
  private file: string;
  private notes: Note[] = [];

  constructor(dir = "data") {
    this.file = path.join(dir, "notes.json");
  }

  async init(): Promise<void> {
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (existsSync(this.file)) {
      this.notes = JSON.parse(readFileSync(this.file, "utf8")) as Note[];
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.notes, null, 2));
  }

  async add(input: NewNote): Promise<Note> {
    const n = makeNote(input);
    this.notes.unshift(n);
    this.save();
    return n;
  }

  async get(id: string): Promise<Note | null> {
    return this.notes.find((n) => n.id === id) ?? null;
  }

  async list(opts: ListOptions = {}): Promise<Note[]> {
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, 200);
    const status = opts.status ?? "inbox";
    const filtered =
      status === "all" ? this.notes : this.notes.filter((n) => n.status === status);
    return [...filtered]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async search(query: string, limit = DEFAULT_LIMIT): Promise<Note[]> {
    const q = query.toLowerCase();
    return this.notes
      .filter((n) => n.text.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(limit, 200));
  }

  async markProcessed(ids: string[]): Promise<number> {
    let count = 0;
    const now = new Date().toISOString();
    for (const n of this.notes) {
      if (ids.includes(n.id) && n.status !== "processed") {
        n.status = "processed";
        n.processedAt = now;
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  async delete(id: string): Promise<boolean> {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    if (this.notes.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}

export function createStore(): NoteStore {
  const url = process.env.DATABASE_URL;
  if (url) return new PgStore(url);
  console.warn("[store] DATABASE_URL not set — using JSON file store (./data/notes.json)");
  return new FileStore();
}
