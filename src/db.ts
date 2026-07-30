import { Database } from "bun:sqlite";

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = new Database("campus-info-hub.sqlite", { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS poll_state (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      last_poll   TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      msg_id       TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id            TEXT PRIMARY KEY,
      category      TEXT NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT,
      event_date    TEXT,
      location      TEXT,
      organizer     TEXT,
      sender_name   TEXT,
      source_quote  TEXT NOT NULL,
      source_group  TEXT NOT NULL,
      source_msg_id TEXT NOT NULL UNIQUE,
      session_id    TEXT NOT NULL DEFAULT '',
      msg_time      INTEGER NOT NULL DEFAULT 0,
      is_verified   INTEGER DEFAULT 0,
      content_hash  TEXT,
      created_at    TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      talker     TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      is_group   INTEGER NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 0,
      last_seen  TEXT
    )
  `);
  // Migration: add enabled column to existing tables (pre-v2 schema)
  try { db.run("ALTER TABLE sessions ADD COLUMN enabled INTEGER DEFAULT 0"); } catch {}
  db.run("UPDATE sessions SET enabled = 0 WHERE enabled IS NULL");
  // Migration: add session_id to items
  try { db.run("ALTER TABLE items ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"); } catch {}
  // Migration: add msg_time to items
  try { db.run("ALTER TABLE items ADD COLUMN msg_time INTEGER NOT NULL DEFAULT 0"); } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS digest (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT NOT NULL,
      item_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS raw_messages (
      msg_id     TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content    TEXT NOT NULL,
      timestamp  INTEGER NOT NULL
    )
  `);

  // Seed poll_state with empty last_poll so first run triggers 24h backfill
  const row = db.query("SELECT id FROM poll_state LIMIT 1").get();
  if (!row) {
    db.run("INSERT INTO poll_state (last_poll, updated_at) VALUES ('', ?)", [new Date().toISOString()]);
  }
}

// ── Items CRUD ──

export interface ItemRow {
  id: string;
  category: string;
  title: string;
  description: string | null;
  event_date: string | null;
  location: string | null;
  organizer: string | null;
  sender_name: string | null;
  source_quote: string;
  source_group: string;
  source_msg_id: string;
  session_id: string;
  msg_time: number;
  is_verified: number;
  content_hash: string | null;
  created_at: string;
}

export function insertItem(item: Omit<ItemRow, "id" | "created_at">): string {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO items (id, category, title, description, event_date, location, organizer,
       sender_name, source_quote, source_group, source_msg_id, session_id, msg_time, is_verified, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, item.category, item.title, item.description, item.event_date,
      item.location, item.organizer, item.sender_name, item.source_quote,
      item.source_group, item.source_msg_id, item.session_id || "", item.msg_time || 0, item.is_verified, item.content_hash, createdAt,
    ]
  );
  return id;
}

export function getItems(filter?: {
  category?: string;
  verified?: "all" | "unverified" | "useful" | "ignored";
}): ItemRow[] {
  const db = getDb();
  let sql = "SELECT * FROM items WHERE 1=1";
  const params: any[] = [];

  if (filter?.category && filter.category !== "全部") {
    sql += " AND category = ?";
    params.push(filter.category);
  }
  if (filter?.verified === "useful") {
    sql += " AND is_verified = 1";
  } else if (filter?.verified === "ignored") {
    sql += " AND is_verified = -1";
  } else if (filter?.verified !== "all") {
    sql += " AND is_verified >= 0"; // hide ignored by default
  }

  sql += " ORDER BY created_at DESC LIMIT 200";
  return db.query(sql).all(...params) as ItemRow[];
}

export function getCategoryCounts(): { key: string; count: number }[] {
  const db = getDb();
  return db.query(
    "SELECT category as key, COUNT(*) as count FROM items WHERE is_verified >= 0 GROUP BY category ORDER BY count DESC"
  ).all() as { key: string; count: number }[];
}

export function getAllCategoryCount(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM items WHERE is_verified >= 0").get() as { count: number };
  return row.count;
}

export function getIgnoredCount(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM items WHERE is_verified = -1").get() as { count: number };
  return row.count;
}

export function updateItemVerify(id: string, verified: number) {
  const db = getDb();
  db.run("UPDATE items SET is_verified = ? WHERE id = ?", [verified, id]);
}

// ── Processed Messages ──

export function isMessageProcessed(msgId: string): boolean {
  const db = getDb();
  const row = db.query("SELECT msg_id FROM processed_messages WHERE msg_id = ?").get(msgId);
  return !!row;
}

export function areMessagesProcessed(msgIds: string[]): Set<string> {
  if (msgIds.length === 0) return new Set();
  const db = getDb();
  const placeholders = msgIds.map(() => "?").join(",");
  const rows = db.query(`SELECT msg_id FROM processed_messages WHERE msg_id IN (${placeholders})`).all(...msgIds) as { msg_id: string }[];
  return new Set(rows.map(r => r.msg_id));
}

export function markMessageProcessed(msgId: string) {
  const db = getDb();
  db.run("INSERT OR IGNORE INTO processed_messages (msg_id, processed_at) VALUES (?, ?)", [
    msgId,
    new Date().toISOString(),
  ]);
}

// ── Poll State ──

export function getLastPollTime(): string {
  const db = getDb();
  const row = db.query("SELECT last_poll FROM poll_state WHERE id = 1").get() as { last_poll: string };
  return row.last_poll;
}

export function updateLastPollTime(time: string) {
  const db = getDb();
  db.run("UPDATE poll_state SET last_poll = ?, updated_at = ? WHERE id = 1", [
    time,
    new Date().toISOString(),
  ]);
}

// ── Sessions ──

export interface SessionRow {
  talker: string;
  name: string;
  is_group: number;
  enabled: number;
  last_seen: string;
}

export function upsertSession(talker: string, name: string, isGroup: boolean) {
  const db = getDb();
  // Only update name/last_seen for existing sessions, preserve enabled
  const existing = db.query("SELECT talker FROM sessions WHERE talker = ?").get(talker);
  if (existing) {
    db.run("UPDATE sessions SET name = ?, is_group = ?, last_seen = ? WHERE talker = ?",
      [name, isGroup ? 1 : 0, new Date().toISOString(), talker]);
  } else {
    db.run("INSERT INTO sessions (talker, name, is_group, enabled, last_seen) VALUES (?, ?, ?, 1, ?)",
      [talker, name, isGroup ? 1 : 0, new Date().toISOString()]);
  }
}

export function getAllSessions(): SessionRow[] {
  const db = getDb();
  return db.query("SELECT * FROM sessions ORDER BY name").all() as SessionRow[];
}

export function getEnabledSessions(): SessionRow[] {
  const db = getDb();
  return db.query("SELECT * FROM sessions WHERE enabled = 1 ORDER BY name").all() as SessionRow[];
}

export function toggleSession(talker: string): SessionRow | null {
  const db = getDb();
  db.run("UPDATE sessions SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE talker = ?", [talker]);
  return db.query("SELECT * FROM sessions WHERE talker = ?").get(talker) as SessionRow | null;
}

export function getSessionName(talker: string): string | null {
  const db = getDb();
  const row = db.query("SELECT name FROM sessions WHERE talker = ?").get(talker) as { name: string } | undefined;
  return row?.name ?? null;
}

// ── Raw Messages (for local context) ──

export function insertRawMessage(
  msgId: string, sessionId: string, groupName: string,
  senderName: string, content: string, timestamp: number
) {
  const db = getDb();
  db.run("INSERT OR IGNORE INTO raw_messages (msg_id, session_id, group_name, sender_name, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    [msgId, sessionId, groupName, senderName, content, timestamp]);
}

export function getContextMessages(sessionId: string, aroundTime: number): { sender: string; content: string; time: number }[] {
  const db = getDb();
  const since = aroundTime - 3600; // 1 hour before
  const until = aroundTime + 3600; // 1 hour after
  const rows = db.query(
    `SELECT sender_name as sender, content, timestamp as time FROM raw_messages
     WHERE session_id = ? AND timestamp BETWEEN ? AND ?
     ORDER BY timestamp LIMIT 30`
  ).all(sessionId, since, until) as { sender: string; content: string; time: number }[];
  return rows;
}

// ── Dedup helpers ──

export function mergeSourceGroup(id: string, newGroup: string) {
  const db = getDb();
  const row = db.query("SELECT source_group FROM items WHERE id = ?").get(id) as { source_group: string } | undefined;
  if (!row) return;
  const existing = row.source_group || "";
  if (!existing.includes(newGroup)) {
    const merged = existing ? `${existing}, ${newGroup}` : newGroup;
    db.run("UPDATE items SET source_group = ? WHERE id = ?", [merged, id]);
  }
}

export function getAllItemTexts(): { id: string; text: string }[] {
  const db = getDb();
  return db.query("SELECT id, (title || ' ' || COALESCE(description,'') || ' ' || source_quote) as text FROM items WHERE is_verified >= 0").all() as { id: string; text: string }[];
}

// ── Digest ──

export function saveDigest(content: string, itemCount: number) {
  const db = getDb();
  db.run("INSERT INTO digest (content, item_count, created_at) VALUES (?, ?, ?)", [
    content, itemCount, new Date().toISOString(),
  ]);
}

export function getLatestDigest(): { content: string; itemCount: number; createdAt: string } | null {
  const db = getDb();
  return db.query("SELECT content, item_count as itemCount, created_at as createdAt FROM digest ORDER BY id DESC LIMIT 1").get() as any;
}

export function getRecentItems(hours: number): ItemRow[] {
  const db = getDb();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return db.query("SELECT * FROM items WHERE created_at >= ? ORDER BY created_at DESC").all(since) as ItemRow[];
}

