import { describe, expect, test } from "bun:test";
import type { BackboardAI } from "./ai";
import { Billing } from "./bills";
import type { Config } from "./config";
import type { ChatContext, Decision, IncomingMessage } from "./contracts";
import { Core } from "./core";
import { Store } from "./db";
import { Planning } from "./planning";

const silent: Decision = {
  is_planning: false,
  confidence: 0.95,
  stage: "idea",
  should_speak: false,
  reason: "ordinary banter",
  extracted: {
    interested: [],
    availability: {},
    time_options: [],
    place_options: [],
  },
  action: null,
};

function fixture(
  overrides: Partial<Pick<BackboardAI, "decide" | "forget">> = {},
) {
  let clock = Date.UTC(2026, 9, 18, 12);
  const store = new Store(":memory:");
  store.ensureChat("group", "UTC", "Demo");
  store.setParticipants("group", [
    { handle: "alex", name: "Alex" },
    { handle: "sam", name: "Sam" },
    { handle: "jo", name: "Jo" },
  ]);
  const planning = new Planning(store.db);
  const billing = new Billing(store.db);
  const config: Config = {
    ai: {
      apiKey: "test-only",
      provider: "test",
      model: "test",
      classifierProvider: "test",
      classifierModel: "test",
      botName: "amigo",
    },
    allowedChats: new Set(["group"]),
    botName: "amigo",
    tz: "UTC",
    passiveMode: "live",
    debounceMs: 45_000,
    burstSize: 8,
    databasePath: ":memory:",
    messagesDatabasePath: "unused",
    contactsPath: "unused",
    allowDMs: false,
  };
  let decisions = 0;
  const ai: Pick<BackboardAI, "decide" | "forget"> = {
    decide: async (ctx, tools) => {
      decisions++;
      return overrides.decide ? await overrides.decide(ctx, tools) : silent;
    },
    forget: async (chatId) => {
      if (overrides.forget) await overrides.forget(chatId);
    },
  };
  const logs: Record<string, unknown>[] = [];
  const sent: { chat: string; text: string }[] = [];
  const core = new Core(
    config,
    store,
    planning,
    billing,
    ai,
    async (chat, text) => {
      store.reserveSend(chat, clock);
      sent.push({ chat, text });
    },
    (event) => logs.push(event),
    () => clock,
  );
  let sequence = 0;
  const receive = (
    text: string,
    handle = "alex",
    changes: Partial<IncomingMessage> = {},
  ) => {
    const message: IncomingMessage = {
      id: `message-${++sequence}`,
      chatId: "group",
      handle,
      text,
      at: clock,
      isFromMe: false,
      isGroup: true,
      kind: "text",
      ...changes,
    };
    core.receive(message);
    return message;
  };
  const ctx = (): ChatContext => ({
    chatId: "group",
    now: clock,
    tz: "UTC",
    botName: "amigo",
    actor: "alex",
    explicit: true,
    participants: store.participants("group"),
    recent: store.recent("group"),
    plan: planning.snapshot("group"),
    bills: billing.snapshot("group"),
  });
  const advance = async (ms: number) => {
    clock += ms;
    core.tick();
    await core.idle();
  };
  return {
    core,
    store,
    planning,
    billing,
    config,
    logs,
    sent,
    receive,
    ctx,
    advance,
    get decisions() {
      return decisions;
    },
    get now() {
      return clock;
    },
    set now(value: number) {
      clock = value;
    },
  };
}

describe("native event pipeline boundaries", () => {
  test("logs incoming text once and excludes unrelated chats, DMs, and own messages", async () => {
    const f = fixture();
    try {
      f.receive("unselected secret", "alex", { chatId: "other" });
      f.receive("private dm", "alex", { isGroup: false });
      f.receive("own message", "alex", { isFromMe: true });
      const message = f.receive("hello\nworld");
      f.core.receive(message);
      expect(f.logs.filter((log) => log.event === "incoming")).toEqual([
        expect.objectContaining({
          text: "hello\nworld",
          sender: "alex",
          chat: "group",
        }),
      ]);
      expect(f.store.recent("group").map((row) => row.text)).toEqual([
        "hello\nworld",
      ]);
      await f.advance(60_000);
      expect(f.decisions).toBe(0);
      expect(f.sent).toEqual([]);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("model work does not block incoming logs or local bill commands", async () => {
    let resolve!: (value: Decision) => void;
    const pending = new Promise<Decision>((done) => {
      resolve = done;
    });
    const f = fixture({ decide: async () => await pending });
    try {
      f.receive("anyone down for food?");
      f.now += 45_000;
      f.core.tick();
      await Promise.resolve();
      f.receive("/split 50");
      f.receive("another message", "sam");
      expect(f.billing.hasOpen("group")).toBe(true);
      expect(
        f.logs.filter((log) => log.event === "incoming").map((log) => log.text),
      ).toContain("another message");
      expect(f.store.pending().some((row) => row.text.includes("$50.00"))).toBe(
        true,
      );
      resolve(silent);
      await f.core.idle();
    } finally {
      resolve(silent);
      await f.core.stop();
      f.store.close();
    }
  });

  test("an explicit poll after /forget starts a plan from the extracted activity", async () => {
    const f = fixture({
      decide: async () => ({
        ...silent,
        is_planning: true,
        stage: "gathering",
        should_speak: true,
        reason: "new plan suggestion",
        extracted: {
          interested: ["alex"],
          availability: {},
          time_options: [],
          place_options: [],
          activity: "dinner",
        },
        action: {
          name: "create_poll",
          args: {
            question: "Who's in?",
            options: ["I'm in", "Can't make it"],
            closes_at: "tomorrow at 9pm",
          },
        },
      }),
    });
    try {
      f.receive("/forget");
      await f.core.idle();
      f.receive("@amigo plan dinner");
      await f.core.idle();
      await f.advance(6000);
      expect(f.planning.snapshot("group")?.what).toBe("dinner");
      expect(f.planning.snapshot("group")?.openPoll?.question).toBe(
        "Who's in?",
      );
      expect(f.sent.some((row) => row.text.includes("Brain freeze"))).toBe(
        false,
      );
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("a failed mid-burst decision is retried after the lull instead of dropped", async () => {
    let calls = 0;
    const f = fixture({
      decide: async () => {
        calls++;
        if (calls === 1) throw new Error("503 UNAVAILABLE");
        return silent;
      },
    });
    try {
      for (let index = 0; index < 8; index++) f.receive("dinner planning");
      f.core.tick();
      await f.core.idle();
      expect(calls).toBe(1);
      await f.advance(45_000);
      expect(calls).toBe(2);
      expect(f.logs.some((log) => log.event === "classification")).toBe(true);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("passive API failures stay silent; explicit failures use the local error template", async () => {
    const f = fixture({
      decide: async () => {
        throw new Error("503 UNAVAILABLE");
      },
    });
    try {
      f.receive("we should hang out");
      await f.advance(45_000);
      expect(f.sent).toEqual([]);
      expect(
        f.logs.some(
          (log) =>
            log.operation === "passive" && String(log.error).includes("503"),
        ),
      ).toBe(true);
      f.receive("@amigo make a plan");
      await f.core.idle();
      await f.advance(1000);
      expect(f.sent.at(-1)?.text).toContain("Brain freeze");
      f.receive("/status");
      await f.advance(5000);
      expect(f.sent.length).toBe(2);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });
});

describe("local workflows remain independent of Backboard", () => {
  test("a split, self-reported payments, and settlement use exact local state", async () => {
    const f = fixture();
    try {
      const split = f.receive("/split 50");
      f.core.receive(split);
      await f.advance(1000);
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0].text).toContain("$50.00");
      expect(f.sent[0].text).toContain("$16.67");
      f.receive("paid", "sam");
      await f.advance(5000);
      f.receive("paid", "jo");
      await f.advance(5000);
      expect(f.billing.hasOpen("group")).toBe(false);
      expect(f.sent.some((row) => /all settled/i.test(row.text))).toBe(true);
      const count = f.sent.length;
      await f.advance(3 * 86_400_000);
      expect(f.sent).toHaveLength(count);
      expect(f.decisions).toBe(0);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("numeric poll votes are recorded without model requests", async () => {
    const f = fixture();
    try {
      f.planning.execute(
        "create_poll",
        {
          title: "Dinner",
          what: "dinner",
          question: "Which day?",
          options: ["Friday", "Saturday"],
          closes_at: f.now + 86_400_000,
        },
        f.ctx(),
      );
      f.receive("1,2", "sam");
      f.receive("none", "jo");
      await f.advance(1000);
      expect(f.planning.snapshot("group")?.openPoll?.voted.sort()).toEqual([
        "jo",
        "sam",
      ]);
      expect(f.decisions).toBe(0);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("quiet/loud are local and quiet suppresses pending proactive speech", async () => {
    const f = fixture();
    try {
      f.store.queue(
        { chatId: "group", text: "Unprompted proposal", key: "proactive" },
        f.now,
        true,
        "1:gathering",
      );
      f.receive("amigo shh");
      expect(f.store.chat("group").quiet_until).toBe(f.now + 86_400_000);
      expect(
        f.store.pending().some((row) => row.text === "Unprompted proposal"),
      ).toBe(false);
      await f.advance(1000);
      f.receive("/loud");
      expect(f.store.chat("group").quiet_until).toBe(0);
      expect(f.decisions).toBe(0);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("forget retains local state on remote failure instead of claiming deletion", async () => {
    const f = fixture({
      forget: async () => {
        throw new Error("503 UNAVAILABLE");
      },
    });
    try {
      f.receive("/split 50");
      f.receive("/forget");
      await f.core.idle();
      expect(f.billing.hasOpen("group")).toBe(true);
      expect(
        f.store
          .pending()
          .some((row) => row.text.includes("could not finish deleting")),
      ).toBe(true);
      expect(f.store.pending().some((row) => row.text.includes("$50.00"))).toBe(
        true,
      );
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });
});

describe("passive lifecycle integration", () => {
  test("shadow extraction updates state without running the action or output", async () => {
    const decision: Decision = {
      ...silent,
      is_planning: true,
      stage: "gathering",
      should_speak: true,
      reason: "Planning stalled with no time proposal",
      extracted: {
        interested: ["alex", "sam"],
        availability: { sam: { yes: ["Friday"], no: ["Saturday"], maybe: [] } },
        time_options: ["Friday", "Saturday"],
        place_options: [],
      },
      action: { name: "nudge", args: {} },
    };
    const f = fixture({ decide: async () => decision });
    f.config.passiveMode = "shadow";
    try {
      f.receive("Friday dinner works for me", "sam");
      await f.advance(45_000);
      await f.advance(1000);
      expect(f.planning.snapshot("group")?.interested).toEqual(["alex", "sam"]);
      expect(f.planning.snapshot("group")?.availability.sam.yes).toHaveLength(
        1,
      );
      expect(f.decisions).toBe(1);
      expect(f.sent).toEqual([]);
      expect(
        f.store.db.query("SELECT spoke FROM classifier_log").get(),
      ).toEqual({ spoke: 0 });
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("a new message invalidates an in-flight proactive action", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = fixture({
      decide: async (ctx) => {
        started();
        await gate;
        return {
          ...silent,
          is_planning: true,
          stage: "gathering",
          should_speak: true,
          reason: "Planning stalled with no time proposal",
          extracted: {
            interested: ["alex", "sam"],
            availability: {},
            time_options: [],
            place_options: [],
          },
          action: {
            name: "create_poll",
            args: {
              question: "Which day?",
              options: ["Friday", "Saturday"],
              closes_at: ctx.now + 86_400_000,
            },
          },
        };
      },
    });
    try {
      for (let index = 0; index < 10; index++)
        f.receive("dinner planning", "alex");
      f.now += 45_000;
      f.core.tick();
      await entered;
      f.receive("wait, we need to change the plan", "sam");
      release();
      await f.core.idle();
      expect(f.planning.snapshot("group")?.openPoll).toBeUndefined();
      expect(f.store.pending()).toEqual([]);
      expect(f.sent).toEqual([]);
    } finally {
      release();
      await f.core.stop();
      f.store.close();
    }
  });

  test("no_reply does not charge budgets or claim a spoken classification", async () => {
    const f = fixture({
      decide: async () => ({
        ...silent,
        is_planning: true,
        stage: "gathering",
        should_speak: true,
        reason: "Planning stalled with no time proposal",
        extracted: {
          interested: ["alex", "sam"],
          availability: {},
          time_options: [],
          place_options: [],
        },
        action: { name: "no_reply", args: {} },
      }),
    });
    try {
      for (let index = 0; index < 10; index++) f.receive("dinner planning");
      await f.advance(45_000);
      expect(f.decisions).toBe(1);
      expect(f.store.chat("group").proactive_today).toBe(0);
      expect(
        f.store.db.query("SELECT spoke FROM classifier_log").get(),
      ).toEqual({ spoke: 0 });
      expect(f.sent).toEqual([]);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("two ignored proactive splits back off for one day without losing the extracted total", async () => {
    const f = fixture({
      decide: async (ctx) => ({
        ...silent,
        bill: {
          is_shared_expense: true,
          total: Number(ctx.message?.text.match(/\d+/)?.[0]),
          payer: "alex",
          includes_tip: "unknown",
          split_hint: null,
          confidence: 0.9,
          paid_by: [],
          fixed_shares: {},
        },
        action: {
          name: "split_bill",
          args: { total: 999, payer: "alex", includes_tip: "unknown" },
        },
      }),
    });
    try {
      f.receive("bill was $50 total");
      await f.advance(45_000);
      await f.advance(1000);
      expect(f.sent[0]?.text).toContain("$50.00");
      expect(f.sent[0]?.text).not.toContain("$999.00");
      expect(f.store.chat("group").unanswered_count).toBe(1);
      f.receive("another bill was $60 total");
      await f.advance(45_000);
      await f.advance(1000);
      expect(f.store.chat("group").unanswered_count).toBe(2);
      f.receive("another bill was $70 total");
      await f.advance(45_000);
      expect(f.store.chat("group").quiet_until).toBe(f.now + 86_400_000);
      expect(f.store.chat("group").unanswered_count).toBe(0);
      await f.advance(1000);
      expect(f.sent.some((row) => row.text.includes("$70.00"))).toBe(false);
      f.now += 86_400_000;
      f.receive("another bill was $80 total");
      await f.advance(45_000);
      expect(
        f.store.pending().some((row) => row.text.includes("$80.00")),
      ).toBe(true);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("scheduled payback output waits for a lull and survives quiet mode", async () => {
    const f = fixture();
    try {
      f.receive("/split 50");
      await f.advance(1000);
      f.now += 86_400_000;
      f.receive("just chatting", "sam");
      await f.advance(1000);
      expect(f.sent).toHaveLength(1);
      expect(
        f.store.pending().some((row) => row.stage_key === "scheduled"),
      ).toBe(true);
      f.receive("/quiet");
      await f.advance(5000);
      expect(f.sent.filter((row) => row.text.includes("still owes"))).toEqual(
        [],
      );
      f.receive("/loud");
      await f.advance(5000);
      expect(f.sent.filter((row) => row.text.includes("still owes"))).toEqual(
        [],
      );
      await f.advance(45_000);
      expect(
        f.sent.filter((row) => row.text.includes("still owes")),
      ).toHaveLength(1);
      f.receive("paid", "sam");
      await f.advance(5000);
      expect(
        f.sent.filter((row) => row.text.includes("still owes")),
      ).toHaveLength(1);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });

  test("structured planning commands work with no Backboard calls", async () => {
    const f = fixture();
    try {
      f.receive("/plan Dinner | dinner | Cafe");
      await f.advance(1000);
      f.receive(
        "/poll Which day? | Friday | Saturday | closes tomorrow at 9pm",
      );
      await f.advance(5000);
      f.receive("/remind tomorrow at 6pm");
      await f.advance(5000);
      expect(f.planning.snapshot("group")?.location).toBe("Cafe");
      expect(f.planning.snapshot("group")?.openPoll?.options).toHaveLength(2);
      expect(
        f.store.db.query("SELECT COUNT(*) AS count FROM reminders").get(),
      ).toEqual({ count: 1 });
      expect(f.decisions).toBe(0);
    } finally {
      await f.core.stop();
      f.store.close();
    }
  });
});
