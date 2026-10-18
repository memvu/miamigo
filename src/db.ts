import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  BufferedMessage,
  DeliveryTag,
  Emission,
  IncomingMessage,
  Participant,
} from "./contracts";

export interface ChatState {
  chat_id: string;
  display_name: string;
  tz: string;
  quiet_until: number;
  proactive_day: string;
  proactive_today: number;
  last_bot_at: number;
  last_eval_rowid: number;
  unanswered_count: number;
  spoke_stage: string;
  last_proactive_at: number;
}

export interface OutboxRow {
  id: number;
  chat_id: string;
  text: string;
  event_key: string;
  tag_json: string | null;
  attachments_json: string | null;
  proactive: number;
  stage_key: string;
  status: string;
  created_at: number;
  sent_at: number | null;
  guid: string | null;
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', tz TEXT NOT NULL,
        quiet_until INTEGER NOT NULL DEFAULT 0, proactive_day TEXT NOT NULL DEFAULT '',
        proactive_today INTEGER NOT NULL DEFAULT 0, last_bot_at INTEGER NOT NULL DEFAULT 0,
        last_eval_rowid INTEGER NOT NULL DEFAULT 0, unanswered_count INTEGER NOT NULL DEFAULT 0,
        spoke_stage TEXT NOT NULL DEFAULT '', last_proactive_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS participants (
        chat_id TEXT NOT NULL, handle TEXT NOT NULL, name TEXT NOT NULL, venmo TEXT, zelle TEXT,
        PRIMARY KEY(chat_id, handle)
      );
      CREATE TABLE IF NOT EXISTS messages (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL, handle TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(chat_id, created_at);
      CREATE TABLE IF NOT EXISTS classifier_log (
        id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, at INTEGER NOT NULL,
        input_rowids TEXT NOT NULL, output_json TEXT NOT NULL, spoke INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL,
        event_key TEXT NOT NULL UNIQUE, tag_json TEXT, attachments_json TEXT,
        proactive INTEGER NOT NULL DEFAULT 0,
        stage_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL, sent_at INTEGER, guid TEXT, failure TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, created_at);
      CREATE TABLE IF NOT EXISTS send_log (id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS send_log_chat_time ON send_log(chat_id, at);
      CREATE TABLE IF NOT EXISTS chat_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_memories_chat ON chat_memories(chat_id);
    `);
    try {
      this.db.run("ALTER TABLE outbox ADD COLUMN attachments_json TEXT");
    } catch {
      // Column already present
    }
    // A process crash after AppleScript dispatch has an uncertain outcome. Never replay it blindly.
    this.db.run(
      "UPDATE outbox SET status = 'failed', failure = 'Delivery interrupted; check Messages before resending.' WHERE status = 'sending'",
    );
  }

  ensureChat(chatId: string, tz: string, name = ""): void {
    this.db
      .query(
        "INSERT INTO chats(chat_id,tz,display_name) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET tz=excluded.tz, display_name=excluded.display_name",
      )
      .run(chatId, tz, name);
  }

  chat(chatId: string): ChatState {
    const chat = this.db
      .query<ChatState, [string]>("SELECT * FROM chats WHERE chat_id = ?")
      .get(chatId);
    if (!chat) throw new Error("The chat is not initialized.");
    return chat;
  }

  setParticipants(chatId: string, people: Participant[]): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM participants WHERE chat_id = ?", [chatId]);
      const insert = this.db.query(
        "INSERT INTO participants(chat_id,handle,name,venmo,zelle) VALUES (?,?,?,?,?)",
      );
      for (const person of people)
        insert.run(
          chatId,
          person.handle,
          person.name,
          person.venmo ?? null,
          person.zelle ?? null,
        );
    })();
  }

  participants(chatId: string): Participant[] {
    return this.db
      .query<
        {
          handle: string;
          name: string;
          venmo: string | null;
          zelle: string | null;
        },
        [string]
      >(
        "SELECT handle,name,venmo,zelle FROM participants WHERE chat_id = ? ORDER BY handle",
      )
      .all(chatId)
      .map((row) => ({
        handle: row.handle,
        name: row.name,
        ...(row.venmo ? { venmo: row.venmo } : {}),
        ...(row.zelle ? { zelle: row.zelle } : {}),
      }));
  }
  addMemory(chatId: string, fact: string, now: number): void {
    const trimmed = fact.trim();
    if (!trimmed) return;
    const exists = this.db
      .query<{ id: number }, [string, string]>(
        "SELECT id FROM chat_memories WHERE chat_id = ? AND fact = ?",
      )
      .get(chatId, trimmed);
    if (!exists) {
      this.db
        .query(
          "INSERT INTO chat_memories(chat_id, fact, created_at) VALUES (?, ?, ?)",
        )
        .run(chatId, trimmed, now);
    }
  }

  memories(chatId: string): string[] {
    return this.db
      .query<{ fact: string }, [string]>(
        "SELECT fact FROM chat_memories WHERE chat_id = ? ORDER BY id ASC",
      )
      .all(chatId)
      .map((row) => row.fact);
  }


  append(message: IncomingMessage): boolean {
    const result = this.db
      .query(
        "INSERT OR IGNORE INTO messages(id,chat_id,handle,text,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        message.id,
        message.chatId,
        message.handle,
        message.text,
        message.at,
      );
    return result.changes === 1;
  }

  recent(chatId: string): BufferedMessage[] {
    return this.db
      .query<BufferedMessage, [string]>(
        "SELECT rowid,id,handle,text,created_at AS at FROM messages WHERE chat_id=? ORDER BY rowid DESC LIMIT 20",
      )
      .all(chatId)
      .reverse();
  }

  queue(
    emission: Emission,
    now: number,
    proactive = false,
    stageKey = "",
  ): boolean {
    if (!emission.text.trim())
      throw new Error("Cannot queue an empty message.");
    return (
      this.db
        .query(
          "INSERT OR IGNORE INTO outbox(chat_id,text,event_key,tag_json,attachments_json,proactive,stage_key,created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          emission.chatId,
          emission.text,
          emission.key,
          emission.tag
            ? JSON.stringify([{ ...emission.tag, key: emission.key }])
            : null,
          emission.attachments ? JSON.stringify(emission.attachments) : null,
          Number(proactive),
          stageKey,
          now,
        ).changes === 1
    );
  }

  pending(): OutboxRow[] {
    return this.db
      .query<OutboxRow, []>(
        "SELECT * FROM outbox WHERE status='queued' ORDER BY id",
      )
      .all();
  }

  canSend(chatId: string, now: number): boolean {
    const recent = this.db
      .query<{ count: number; last: number | null }, [string, number]>(
        "SELECT COUNT(*) AS count, MAX(at) AS last FROM send_log WHERE chat_id=? AND at>?",
      )
      .get(chatId, now - 3_600_000);
    if (!recent) throw new Error("Cannot read persistent send limits.");
    return (
      recent.count < 30 && (recent.last === null || now - recent.last >= 5000)
    );
  }

  reserveSend(chatId: string, now: number): void {
    this.db.transaction(() => {
      if (!this.canSend(chatId, now))
        throw new Error("The per-chat send limit has been reached.");
      this.db
        .query("INSERT INTO send_log(chat_id,at) VALUES (?,?)")
        .run(chatId, now);
    })();
  }

  sent(row: OutboxRow, now: number, guid?: string): void {
    this.db.transaction(() => {
      const changed = this.db
        .query(
          "UPDATE outbox SET status='sent', sent_at=COALESCE(sent_at,?), guid=COALESCE(guid,?) WHERE id=? AND status!='sent'",
        )
        .run(now, guid ?? null, row.id).changes;
      if (changed) {
        this.db
          .query(
            "UPDATE chats SET last_bot_at=?, unanswered_count=unanswered_count+?, last_proactive_at=CASE WHEN ?=1 THEN ? ELSE last_proactive_at END WHERE chat_id=?",
          )
          .run(now, row.proactive, row.proactive, now, row.chat_id);
      }
      if (guid)
        this.db.query("UPDATE outbox SET guid=? WHERE id=?").run(guid, row.id);
    })();
  }

  bindOutgoing(message: IncomingMessage): OutboxRow | null {
    const row = this.db
      .query<OutboxRow, [string, string, number]>(
        "SELECT * FROM outbox WHERE chat_id=? AND text=? AND status IN ('sending','sent') AND guid IS NULL AND created_at<=? ORDER BY id DESC LIMIT 1",
      )
      .get(message.chatId, message.text, message.at + 1000);
    if (
      !row ||
      (row.sent_at !== null && Math.abs(message.at - row.sent_at) > 60_000)
    )
      return null;
    this.sent(row, message.at, message.id);
    return row;
  }

  tags(row: OutboxRow): DeliveryTag[] {
    return row.tag_json ? (JSON.parse(row.tag_json) as DeliveryTag[]) : [];
  }

  cancelQueued(chatId: string, proactiveOnly = false): void {
    this.db
      .query(
        `UPDATE outbox SET status='cancelled' WHERE chat_id=? AND status='queued'${proactiveOnly ? " AND proactive=1" : ""}`,
      )
      .run(chatId);
  }

  prune(now: number): void {
    const cutoff = now - 7 * 86_400_000;
    this.db.query("DELETE FROM messages WHERE created_at<?").run(cutoff);
    this.db.query("DELETE FROM classifier_log WHERE at<?").run(cutoff);
    this.db
      .query("DELETE FROM outbox WHERE status!='queued' AND created_at<?")
      .run(cutoff);
    this.db.query("DELETE FROM send_log WHERE at<?").run(now - 3_600_000);
  }

  forget(chatId: string): void {
    this.db.transaction(() => {
      for (const table of ["messages", "classifier_log", "outbox", "send_log", "chat_memories"])
        this.db.query(`DELETE FROM ${table} WHERE chat_id=?`).run(chatId);
      this.db
        .query(
          "UPDATE chats SET quiet_until=0,proactive_today=0,proactive_day='',last_eval_rowid=0,unanswered_count=0,spoke_stage='',last_bot_at=0,last_proactive_at=0 WHERE chat_id=?",
        )
        .run(chatId);
    })();
  }

  close(): void {
    this.db.close();
  }
}
