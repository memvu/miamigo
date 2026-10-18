import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db";

const message = (id: string, chatId: string, at: number) => ({
  id,
  chatId,
  at,
  handle: "alex",
  text: "hello",
  isFromMe: false,
  isGroup: true,
  kind: "text",
});

test("send spacing and hourly caps survive store restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "miamigo-limits-"));
  const path = join(directory, "state.db");
  let store = new Store(path);
  try {
    store.ensureChat("group", "UTC");
    const start = 1_000_000;
    store.reserveSend("group", start);
    expect(() => store.reserveSend("group", start + 4999)).toThrow();
    store.close();
    store = new Store(path);
    expect(store.canSend("group", start + 4999)).toBe(false);
    for (let index = 1; index < 30; index++)
      store.reserveSend("group", start + index * 5000);
    expect(store.canSend("group", start + 150_000)).toBe(false);
    expect(store.canSend("other", start + 150_000)).toBe(true);
    expect(store.canSend("group", start + 3_600_000)).toBe(true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("outbox deduplicates events and does not replay an uncertain dispatch after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "miamigo-outbox-"));
  const path = join(directory, "state.db");
  let store = new Store(path);
  try {
    store.ensureChat("group", "UTC");
    const emission = {
      chatId: "group",
      text: "Remember dinner",
      key: "reminder:1",
    };
    expect(store.queue(emission, 1000)).toBe(true);
    expect(store.queue(emission, 1000)).toBe(false);
    store.db.run("UPDATE outbox SET status='sending'");
    store.close();
    store = new Store(path);
    expect(store.pending()).toEqual([]);
    expect(
      store.db.query<{ status: string }, []>("SELECT status FROM outbox").get()
        ?.status,
    ).toBe("failed");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("seven-day retention and chat-scoped forgetting preserve unrelated chat state", () => {
  const store = new Store(":memory:");
  try {
    const now = 10 * 86_400_000;
    store.ensureChat("a", "UTC");
    store.ensureChat("b", "UTC");
    store.append(message("old", "a", now - 7 * 86_400_000 - 1));
    store.append(message("boundary", "a", now - 7 * 86_400_000));
    store.append(message("other", "b", now));
    store.prune(now);
    expect(store.recent("a").map((row) => row.id)).toEqual(["boundary"]);
    store.forget("a");
    expect(store.recent("a")).toEqual([]);
    expect(store.recent("b").map((row) => row.id)).toEqual(["other"]);
  } finally {
    store.close();
  }
});

test("outgoing observations bind only matching pending bot messages", () => {
  const store = new Store(":memory:");
  try {
    store.ensureChat("group", "UTC");
    store.queue(
      {
        chatId: "group",
        text: "Bill split",
        key: "bill:1",
        tag: { kind: "bill", id: 1 },
      },
      1000,
    );
    store.db.run("UPDATE outbox SET status='sending'");
    expect(
      store.bindOutgoing({
        ...message("own", "group", 2000),
        isFromMe: true,
        text: "unrelated manual send",
      }),
    ).toBeNull();
    const row = store.bindOutgoing({
      ...message("bot-guid", "group", 2000),
      isFromMe: true,
      text: "Bill split",
    });
    expect(row?.event_key).toBe("bill:1");
    expect(
      store.db.query<{ guid: string }, []>("SELECT guid FROM outbox").get()
        ?.guid,
    ).toBe("bot-guid");
  } finally {
    store.close();
  }
});
