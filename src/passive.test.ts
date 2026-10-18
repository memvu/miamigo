import { describe, expect, test } from "bun:test";
import type { Classification, PlanSnapshot } from "./contracts";
import type { ChatState } from "./db";
import { Bursts, dayKey, passesGate, speakingPolicy } from "./passive";

const now = Date.UTC(2026, 9, 18, 12);
const chat: ChatState = {
  chat_id: "group",
  display_name: "Demo",
  tz: "America/Los_Angeles",
  quiet_until: 0,
  proactive_day: "",
  proactive_today: 0,
  last_bot_at: 0,
  last_eval_rowid: 0,
  unanswered_count: 0,
  spoke_stage: "",
  last_proactive_at: 0,
};
const plan: PlanSnapshot = {
  id: 1,
  title: "Dinner",
  what: "dinner",
  location: null,
  startsAt: null,
  stage: "gathering",
  going: [],
  interested: ["alex", "sam"],
  timeOptions: [],
  placeOptions: [],
  availability: {},
  proposedAt: null,
  lockedAt: null,
  stageChangedAt: now - 21 * 60_000,
};
const decision: Classification = {
  is_planning: true,
  confidence: 0.9,
  stage: "gathering",
  should_speak: true,
  reason: "The plan has stalled without a concrete proposal",
  extracted: {
    interested: ["alex", "sam"],
    availability: {},
    time_options: [],
    place_options: [],
  },
};
const base = {
  chat,
  decision,
  plan,
  now,
  lastMessageAt: now - 45_000,
  debounceMs: 45_000,
  recentCount: 4,
  participantCount: 3,
};

describe("passive cost and interruption boundaries", () => {
  test("drops banter and unrelated purchases, but tracks active conversations", () => {
    expect(passesGate("lol hilarious", false, false)).toBe(false);
    expect(passesGate("this jacket was $50", false, false)).toBe(false);
    expect(passesGate("bill was $50 total", false, false)).toBe(true);
    expect(passesGate("anyone down for food", false, false)).toBe(true);
    expect(passesGate("yesss", true, false)).toBe(true);
    expect(passesGate("sent it", false, true)).toBe(true);
  });
  test("eight messages permit classification but speech must wait for a lull", () => {
    const bursts = new Bursts();
    for (let i = 0; i < 8; i++) bursts.receive("group", now + i * 100, true);
    expect(bursts.due(now + 700, 45_000, 8)).toEqual(["group"]);
    expect(speakingPolicy({ ...base, lastMessageAt: now - 100 }).reason).toBe(
      "mid-burst",
    );
    bursts.evaluated("group", 8, { ...decision, action: null });
    expect(bursts.due(now + 701, 45_000, 8)).toEqual([]);
    expect(bursts.due(now + 45_700, 45_000, 8)).toEqual(["group"]);
  });
  test("new messages during evaluation remain pending", () => {
    const bursts = new Bursts();
    bursts.receive("group", now, true);
    bursts.receive("group", now + 100, false);
    bursts.evaluated("group", 1, { ...decision, action: null });
    expect(bursts.pending.get("group")?.version).toBe(2);
    expect(bursts.pending.get("group")?.evaluated).toBe(1);
  });
});

describe("proactive safeguards", () => {
  test("allows a plan suggestion at idea or gathering stage, but blocks locked plans", () => {
    expect(speakingPolicy(base).allow).toBe(true);
    expect(
      speakingPolicy({ ...base, plan: { ...plan, stage: "idea" } }).allow,
    ).toBe(true);
    expect(
      speakingPolicy({ ...base, plan: { ...plan, stage: "locked" } }).allow,
    ).toBe(false);
  });
  test("enforces confidence, quiet, and unanswered-message boundaries", () => {
    expect(
      speakingPolicy({ ...base, decision: { ...decision, confidence: 0.69 } })
        .allow,
    ).toBe(false);
    expect(
      speakingPolicy({ ...base, decision: { ...decision, should_speak: false } })
        .allow,
    ).toBe(false);
    expect(
      speakingPolicy({ ...base, chat: { ...chat, quiet_until: now + 1 } })
        .allow,
    ).toBe(false);
    expect(
      speakingPolicy({ ...base, chat: { ...chat, unanswered_count: 2 } })
        .reason,
    ).toBe("unanswered-backoff");
  });
  test("bill confidence bypasses the stage budget but not quiet, lull, or daily limits", () => {
    const bill = {
      is_shared_expense: true,
      total: 50,
      payer: "alex",
      includes_tip: "unknown" as const,
      split_hint: null,
      confidence: 0.8,
      paid_by: [],
      fixed_shares: {},
    };
    const billCase = {
      ...base,
      chat: { ...chat, spoke_stage: "1:gathering" },
      decision: { ...decision, is_planning: false, should_speak: false, bill },
    };
    expect(speakingPolicy(billCase).allow).toBe(true);
    expect(
      speakingPolicy({
        ...billCase,
        decision: { ...billCase.decision, bill: { ...bill, confidence: 0.79 } },
      }).allow,
    ).toBe(false);
    expect(speakingPolicy({ ...billCase, lastMessageAt: now }).allow).toBe(
      false,
    );
    expect(
      speakingPolicy({ ...billCase, chat: { ...chat, quiet_until: now + 100 } })
        .allow,
    ).toBe(false);
  });
  test("daily budget uses the conversation timezone", () => {
    const midnightUTC = Date.UTC(2026, 9, 19, 1);
    expect(dayKey(midnightUTC, "America/Los_Angeles")).toBe("2026-10-18");
    expect(dayKey(midnightUTC, "UTC")).toBe("2026-10-19");
  });
});
