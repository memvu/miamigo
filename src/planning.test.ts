import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ChatContext, Classification, IncomingMessage } from "./contracts";
import { Planning } from "./planning";

const NOW = Date.parse("2026-10-18T17:00:00.000Z");
const PARTICIPANTS = [
  { handle: "alice", name: "Alex" },
  { handle: "bob", name: "Jess" },
  { handle: "sam", name: "Sam" },
];

function context(overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    chatId: "chat-1",
    now: NOW,
    tz: "America/Los_Angeles",
    botName: "Mi Amigo",
    actor: "alice",
    explicit: false,
    participants: PARTICIPANTS,
    recent: [],
    plan: null,
    bills: null,
    ...overrides,
  };
}

function classification(
  interested: string[],
  overrides: Partial<Classification["extracted"]> = {},
): Classification {
  return {
    is_planning: true,
    confidence: 0.95,
    stage: "gathering",
    should_speak: false,
    reason: "state extraction",
    extracted: {
      interested,
      availability: {},
      time_options: [],
      place_options: [],
      ...overrides,
    },
  };
}

function message(text: string, handle = "alice"): IncomingMessage {
  return {
    id: `${handle}-${text}`,
    chatId: "chat-1",
    handle,
    text,
    at: NOW,
    isFromMe: false,
    isGroup: true,
    kind: "text",
  };
}

describe("planning state", () => {
  test("persists interested candidates and merges availability by handle", () => {
    const db = new Database(":memory:");
    const planning = new Planning(db);
    planning.merge(context(), classification(["Alex"], { activity: "Dinner" }));
    expect(planning.hasActive("chat-1")).toBe(true);
    expect(planning.snapshot("chat-1")?.stage).toBe("idea");

    planning.merge(
      context({ now: NOW + 1_000 }),
      classification(["Jess"], {
        availability: { Jess: { yes: ["Fri"], no: ["Sat"], maybe: [] } },
        time_options: ["Fri", "Sat"],
      }),
    );
    const snapshot = planning.snapshot("chat-1");
    expect(snapshot?.interested).toEqual(["alice", "bob"]);
    expect(snapshot?.availability.bob).toEqual({
      yes: ["Fri 10/23"],
      no: ["Sat 10/24"],
      maybe: [],
    });
    expect(snapshot?.timeOptions).toEqual(["Fri 10/23", "Sat 10/24"]);
    db.close();
  });

  test("renders a local poll tally and accepts none/all without an LLM", () => {
    const db = new Database(":memory:");
    const planning = new Planning(db);
    const start = planning.execute(
      "start_plan",
      { title: "Dinner", what: "dinner" },
      context({ explicit: true }),
    );
    expect(start.emissions[0]?.text).toContain("New plan: Dinner");
    const poll = planning.execute(
      "create_poll",
      {
        question: "Which day works?",
        options: ["Fri", "Sat", "Sun"],
        closes_at: NOW + 86_400_000,
      },
      context({ explicit: true }),
    );
    expect(poll.emissions[0]?.text).toContain("POLL #");

    const none = planning.handleMessage(context(), message("none", "alice"));
    expect(none?.data).toMatchObject({ accepted: true, choices: [] });
    const all = planning.handleMessage(
      context({ now: NOW + 31_000 }),
      message("all", "bob"),
    );
    expect(all?.data).toMatchObject({ accepted: true, choices: [0, 1, 2] });
    expect(all?.emissions[0]?.text).toContain("Still waiting on: @Sam");
    db.close();
  });

  test("proposes first, auto-locks after ten minutes, and schedules durable reminders", () => {
    const db = new Database(":memory:");
    const planning = new Planning(db);
    const startsAt = NOW + 3 * 86_400_000;
    planning.execute(
      "start_plan",
      {
        title: "Dinner",
        what: "dinner",
        location: "Pho Bac",
        starts_at: startsAt,
        going: ["alice", "bob"],
      },
      context({ explicit: true }),
    );
    const proposal = planning.execute(
      "finalize_plan",
      {},
      context({ explicit: true }),
    );
    const proposalEmission = proposal.emissions[0];
    if (!proposalEmission?.tag) {
      throw new Error("plan proposal was not emitted");
    }
    expect(proposalEmission.text).toContain("PROPOSED");
    expect(planning.snapshot("chat-1")?.stage).toBe("ready_to_lock");
    expect(planning.snapshot("chat-1")?.proposedAt).toBeNull();

    const sentAt = NOW + 60_000;
    planning.sent(
      proposalEmission.tag,
      "proposal-guid",
      sentAt,
      proposalEmission.key,
    );
    expect(planning.snapshot("chat-1")?.proposedAt).toBe(sentAt);
    const beforeDeadline = planning.tick(
      context({ now: sentAt + 10 * 60_000 - 1 }),
    );
    expect(
      beforeDeadline.emissions.some((item) => item.text.includes("LOCKED IN")),
    ).toBe(false);
    const locked = planning.tick(context({ now: sentAt + 10 * 60_000 }));
    expect(
      locked.emissions.some((item) => item.text.includes("LOCKED IN")),
    ).toBe(true);
    expect(planning.snapshot("chat-1")?.lockedAt).toBe(sentAt + 10 * 60_000);
    const reminderTick = planning.tick(context({ now: startsAt - 86_400_000 }));
    expect(reminderTick.emissions[0]?.text).toContain("Reminder");
    db.close();
  });

  test("reopens a locked plan on an objection and forgets all private rows", () => {
    const db = new Database(":memory:");
    const planning = new Planning(db);
    planning.execute(
      "start_plan",
      {
        title: "Dinner",
        what: "dinner",
        location: "Pho Bac",
        starts_at: NOW + 86_400_000,
        going: ["alice", "bob"],
      },
      context({ explicit: true }),
    );
    expect(() =>
      planning.execute(
        "finalize_plan",
        { confirmed: true },
        context({ explicit: true }),
      ),
    ).toThrow();
    const proposal = planning.execute(
      "finalize_plan",
      {},
      context({ explicit: true }),
    );
    const proposalEmission = proposal.emissions[0];
    if (!proposalEmission?.tag) {
      throw new Error("plan proposal was not emitted");
    }
    planning.sent(
      proposalEmission.tag,
      "proposal-guid",
      NOW + 1,
      proposalEmission.key,
    );
    planning.handleMessage(context({ now: NOW + 2 }), message("yes"));
    expect(planning.snapshot("chat-1")?.stage).toBe("locked");
    planning.handleMessage(context(), message("wait can we move it?", "bob"));
    expect(planning.snapshot("chat-1")?.stage).not.toBe("locked");
    planning.forget("chat-1");
    expect(planning.snapshot("chat-1")).toBeNull();
    expect(planning.hasActive("chat-1")).toBe(false);
    db.close();
  });
  test("filters obsolete proposals while preserving a closed poll tally", () => {
    const db = new Database(":memory:");
    const planning = new Planning(db);
    planning.execute(
      "start_plan",
      {
        title: "Dinner",
        what: "dinner",
        location: "Pho Bac",
        starts_at: NOW + 86_400_000,
        going: ["alice", "bob"],
      },
      context({ explicit: true }),
    );
    const planId = planning.snapshot("chat-1")?.id;
    if (planId === undefined) {
      throw new Error("test plan was not persisted");
    }
    const proposal = planning.execute(
      "finalize_plan",
      {},
      context({ explicit: true }),
    );
    const proposalEmission = proposal.emissions[0];
    if (!proposalEmission?.tag) {
      throw new Error("plan proposal was not emitted");
    }
    expect(
      planning.isDeliverable(proposalEmission.tag, NOW, proposalEmission.key),
    ).toBe(true);
    planning.handleMessage(context(), message("wait", "bob"));
    expect(
      planning.isDeliverable(proposalEmission.tag, NOW, proposalEmission.key),
    ).toBe(false);

    const poll = planning.execute(
      "create_poll",
      {
        question: "Which day?",
        options: ["Fri", "Sat"],
        closes_at: NOW + 1_000,
      },
      context({ explicit: true }),
    );
    const pollId = poll.emissions.find((item) => item.tag?.kind === "poll")?.tag
      ?.id;
    if (pollId === undefined) {
      throw new Error("test poll was not emitted");
    }
    const closed = planning.tick(context({ now: NOW + 2_000 }));
    const closedTally = closed.emissions.find(
      (item) => item.tag?.kind === "poll",
    );
    expect(closedTally).toBeDefined();
    if (!closedTally?.tag) {
      throw new Error("closed poll tally was not emitted");
    }
    expect(
      planning.isDeliverable(closedTally.tag, NOW + 2_000, closedTally.key),
    ).toBe(true);
    expect(
      planning.handleMessage(context({ now: NOW + 2_001 }), message("1"))?.data,
    ).toMatchObject({ accepted: false, reason: "closed" });
    db.close();
  });
});
