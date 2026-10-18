import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Billing, splitBill } from "./bills";
import type {
  ChatContext,
  Classification,
  IncomingMessage,
  PlanSnapshot,
} from "./contracts";

const NOW = 1_800_000_000_000;
const participants = [
  { handle: "minh", name: "Minh", venmo: "minh-b" },
  { handle: "alex", name: "Alex" },
  { handle: "jess", name: "Jess" },
  { handle: "sam", name: "Sam" },
];

const databases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function context(
  database: Database,
  actor = "minh",
  now = NOW,
  plan: PlanSnapshot | null = null,
  chatId = "chat-1",
  knownParticipants = participants,
): ChatContext {
  void database;
  return {
    chatId,
    now,
    tz: "America/Los_Angeles",
    botName: "amigo",
    actor,
    explicit: true,
    participants: knownParticipants,
    recent: [],
    plan,
    bills: null,
  };
}

function makeBilling(): { billing: Billing; database: Database } {
  const database = new Database(":memory:");
  databases.push(database);
  return { billing: new Billing(database), database };
}
function classification(paidBy: string[] = []): Classification {
  return {
    is_planning: false,
    confidence: 0.95,
    stage: "done",
    should_speak: false,
    reason: "payment report",
    extracted: {
      interested: [],
      availability: {},
      time_options: [],
      place_options: [],
    },
    bill: {
      is_shared_expense: true,
      total: 50,
      payer: "minh",
      includes_tip: "unknown",
      split_hint: null,
      confidence: 0.95,
      paid_by: paidBy,
      fixed_shares: {},
    },
  };
}

test("splitBill conserves cents and allocates remainder to non-payers first", () => {
  const shares = splitBill(100, ["minh", "alex", "jess"], {}, "minh");

  expect(shares).toEqual({ minh: 33, alex: 34, jess: 33 });
  expect(Object.values(shares).reduce((sum, cents) => sum + cents, 0)).toBe(
    100,
  );
});
test("splitBill assigns leftover cents to the same non-payer in participant order", () => {
  const people = ["minh", "alex", "jess"];

  expect(splitBill(10, people, {}, "minh")).toEqual({
    minh: 3,
    alex: 4,
    jess: 3,
  });
  expect(splitBill(10, people, {}, "minh")).toEqual({
    minh: 3,
    alex: 4,
    jess: 3,
  });
  expect(splitBill(10, ["minh", "jess", "alex"], {}, "minh")).toEqual({
    minh: 3,
    jess: 4,
    alex: 3,
  });
});

test("splitBill keeps fixed corrections and rejects invalid totals", () => {
  expect(
    splitBill(1_000, ["minh", "alex", "jess"], { alex: 200 }, "minh"),
  ).toEqual({
    alex: 200,
    minh: 400,
    jess: 400,
  });
  expect(() =>
    splitBill(99, ["minh", "alex"], { alex: 1_00 }, "minh"),
  ).toThrow();
  expect(() => splitBill(100, ["minh", "alex"], { sam: 10 }, "minh")).toThrow();
  expect(() => splitBill(100, ["minh", "alex"], {}, "sam")).toThrow();
});

test("splitBill includes payer consumption without creating payer debt", () => {
  const { billing, database } = makeBilling();
  const result = billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess", "sam"] },
    context(database),
  );

  expect(result.emissions[0]?.text).toContain("$50.00 total, 4 people");
  const snapshot = billing.snapshot("chat-1") as {
    bills: Array<{
      shares: Array<{
        handle: string;
        amountCents: number;
        paidAt: number | null;
      }>;
    }>;
  };
  const shares = snapshot.bills[0].shares;
  expect(shares).toHaveLength(4);
  expect(shares.find((share) => share.handle === "minh")?.amountCents).toBe(
    1_250,
  );
  expect(shares.find((share) => share.handle === "minh")?.paidAt).toBe(NOW);
  expect(
    result.emissions.some((emission) => emission.text.includes("owes Minh")),
  ).toBe(false);
});
test("adjust_share fixes one debtor and conserves the remaining cents", () => {
  const { billing, database } = makeBilling();
  billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess"] },
    context(database),
  );
  const corrected = billing.execute(
    "adjust_share",
    { handle: "alex", amount: 8 },
    context(database, "alex", NOW + 1),
  );
  expect(corrected.emissions[0]?.text).toContain("$8.00");
  const shares = (
    billing.snapshot("chat-1") as {
      bills: Array<{ shares: Array<{ handle: string; amountCents: number }> }>;
    }
  ).bills[0].shares;
  expect(shares.find((share) => share.handle === "alex")?.amountCents).toBe(
    800,
  );
  expect(shares.reduce((sum, share) => sum + share.amountCents, 0)).toBe(5_000);
});
test("redistribution preserves paid debtor credit and rejects changing that paid amount", () => {
  const { billing, database } = makeBilling();
  billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess"] },
    context(database),
  );
  billing.execute("mark_paid", {}, context(database, "alex", NOW + 1));

  const corrected = billing.execute(
    "adjust_share",
    { handle: "jess", amount: 8 },
    context(database, "jess", NOW + 2),
  );
  expect(corrected.data).toMatchObject({ billId: 1 });

  const changedPaidShare = billing.execute(
    "adjust_share",
    { handle: "alex", amount: 9 },
    context(database, "alex", NOW + 3),
  );
  expect(changedPaidShare.data).toEqual({
    error: "This share is already paid and its amount cannot be changed.",
  });

  const snapshot = billing.snapshot("chat-1") as {
    bills: Array<{
      shares: Array<{
        handle: string;
        amountCents: number;
        paidAt: number | null;
      }>;
    }>;
  };
  const shares = snapshot.bills[0].shares;
  expect(shares.find((share) => share.handle === "alex")).toMatchObject({
    amountCents: 1_667,
    paidAt: NOW + 1,
  });
  expect(shares.find((share) => share.handle === "jess")?.amountCents).toBe(
    800,
  );
  expect(shares.reduce((sum, share) => sum + share.amountCents, 0)).toBe(5_000);
});

test("participant priority uses explicit identities, then a recent locked plan", () => {
  const { billing, database } = makeBilling();
  const plan: PlanSnapshot = {
    id: 7,
    title: "Dinner",
    what: "dinner",
    location: "Pho Bac",
    startsAt: NOW - 2 * 60 * 60 * 1000,
    stage: "locked",
    going: ["minh", "alex"],
    interested: ["minh", "alex"],
    timeOptions: [],
    placeOptions: [],
    availability: {},
    proposedAt: null,
    lockedAt: NOW - 8 * 60 * 60 * 1000,
    stageChangedAt: NOW - 8 * 60 * 60 * 1000,
  };
  const result = billing.execute(
    "split_bill",
    { total: 50 },
    context(database, "minh", NOW, plan),
  );
  expect(result.data).toBeDefined();
  const planShares = (
    billing.snapshot("chat-1") as { bills: Array<{ shares: unknown[] }> }
  ).bills[0].shares;
  expect(planShares).toHaveLength(2);

  const { billing: explicitBilling, database: explicitDatabase } =
    makeBilling();
  const explicit = explicitBilling.execute(
    "split_bill",
    { total: 50, split_hint: "Alex and Jess" },
    context(explicitDatabase),
  );
  expect(explicit.data).toBeDefined();
  const explicitShares = (
    explicitBilling.snapshot("chat-1") as {
      bills: Array<{ shares: Array<{ handle: string }> }>;
    }
  ).bills[0].shares;
  expect(new Set(explicitShares.map((share) => share.handle))).toEqual(
    new Set(["alex", "jess", "minh"]),
  );
});

test("unknown split identities never create a fictitious participant", () => {
  const { billing, database } = makeBilling();
  const result = billing.execute(
    "split_bill",
    { total: 50, split_hint: "Minh, Alex, Taylor" },
    context(database),
  );

  expect(result.data).toEqual({
    error: "I need identities that are known in this chat.",
  });
  expect(
    (billing.snapshot("chat-1") as { bills: unknown[] }).bills,
  ).toHaveLength(0);
});
test("observe never creates a passive bill and rejects unrelated payment reports", () => {
  const { billing, database } = makeBilling();
  expect(billing.observe(context(database), classification())).toBeNull();
  expect(
    (billing.snapshot("chat-1") as { bills: unknown[] }).bills,
  ).toHaveLength(0);

  billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess"] },
    context(database),
  );
  expect(
    billing.observe(context(database, "jess"), classification(["alex"])),
  ).toBeNull();
  const before = billing.snapshot("chat-1") as {
    bills: Array<{ shares: Array<{ handle: string; paidAt: number | null }> }>;
  };
  expect(
    before.bills[0].shares.find((share) => share.handle === "alex")?.paidAt,
  ).toBeNull();
  billing.observe(context(database, "minh"), classification(["alex"]));
  const after = billing.snapshot("chat-1") as {
    bills: Array<{ shares: Array<{ handle: string; paidAt: number | null }> }>;
  };
  expect(
    after.bills[0].shares.find((share) => share.handle === "alex")?.paidAt,
  ).toBe(NOW);
});

test("participant exclusions preserve known group membership and reject excluding payer", () => {
  const { billing, database } = makeBilling();
  const excluded = billing.execute(
    "split_bill",
    { total: 50, split_hint: "everyone except Sam" },
    context(database),
  );
  expect(excluded.data).toBeDefined();
  const shares = (
    billing.snapshot("chat-1") as {
      bills: Array<{ shares: Array<{ handle: string }> }>;
    }
  ).bills[0].shares;
  expect(shares.map((share) => share.handle)).toEqual(["minh", "alex", "jess"]);
  const partial = billing.execute(
    "split_bill",
    { total: 50, split_hint: "3 ways, Sam didn't come" },
    context(database),
  );
  expect(partial.data).toBeDefined();
  const partialShares = (
    billing.snapshot("chat-1") as {
      bills: Array<{ shares: Array<{ handle: string }> }>;
    }
  ).bills[0].shares;
  expect(partialShares.map((share) => share.handle)).toEqual([
    "minh",
    "alex",
    "jess",
  ]);

  const { billing: payerExcludedBilling, database: payerExcludedDatabase } =
    makeBilling();
  const payerExcluded = payerExcludedBilling.execute(
    "split_bill",
    { total: 50, split_hint: "Minh didn't come" },
    context(payerExcludedDatabase),
  );
  expect(payerExcluded.data).toEqual({
    error: "The payer cannot be excluded from a split.",
  });
  expect(
    (payerExcludedBilling.snapshot("chat-1") as { bills: unknown[] }).bills,
  ).toHaveLength(0);
});

test("tip question is answered once and applies exact cents locally", () => {
  const { billing, database } = makeBilling();
  const initial = billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess", "sam"], includes_tip: "no" },
    context(database),
  );
  expect(initial.emissions[0]?.text).toContain("1) 18%");

  const message: IncomingMessage = {
    id: "tip-answer",
    chatId: "chat-1",
    handle: "minh",
    text: "1",
    at: NOW + 1,
    isFromMe: false,
    isGroup: true,
    kind: "text",
  };
  const answered = billing.handleMessage(
    context(database, "minh", NOW + 1),
    message,
  );
  expect(answered?.emissions[0]?.text).toContain("$59.00 total");
  const shares = (
    billing.snapshot("chat-1") as {
      bills: Array<{ shares: Array<{ amountCents: number }> }>;
    }
  ).bills[0].shares;
  expect(shares.every((share) => share.amountCents === 1_475)).toBe(true);
});
test("an invalid no-tip split stays pending and accepts a valid retry", () => {
  const { billing, database } = makeBilling();
  billing.execute(
    "split_bill",
    {
      total: 50,
      people: ["minh", "alex", "jess"],
      includes_tip: "no",
      fixed_shares: { Alex: 30, Jess: 25 },
    },
    context(database),
  );

  const noTipAnswer: IncomingMessage = {
    id: "no-tip-answer",
    chatId: "chat-1",
    handle: "minh",
    text: "4",
    at: NOW + 1,
    isFromMe: false,
    isGroup: true,
    kind: "text",
  };
  const invalid = billing.handleMessage(
    context(database, "minh", NOW + 1),
    noTipAnswer,
  );
  expect(invalid?.data).toEqual({ error: "fixed shares exceed total" });

  const pendingSnapshot = billing.snapshot("chat-1") as {
    bills: Array<{
      tipCents: number;
      tipPending: boolean;
      shares: unknown[];
    }>;
  };
  expect(pendingSnapshot.bills[0]).toMatchObject({
    tipCents: 0,
    tipPending: true,
    shares: [],
  });

  const retry = billing.handleMessage(context(database, "minh", NOW + 2), {
    ...noTipAnswer,
    id: "tip-retry",
    text: "2",
    at: NOW + 2,
  });
  expect(retry?.emissions[0]?.text).toContain("$60.00 total");
  const resolvedSnapshot = billing.snapshot("chat-1") as {
    bills: Array<{
      tipCents: number;
      tipPending: boolean;
      shares: Array<{ amountCents: number }>;
    }>;
  };
  expect(resolvedSnapshot.bills[0].tipCents).toBe(1_000);
  expect(resolvedSnapshot.bills[0].tipPending).toBe(false);
  expect(
    resolvedSnapshot.bills[0].shares.reduce(
      (sum, share) => sum + share.amountCents,
      0,
    ),
  ).toBe(6_000);
});

test("payment reports require debtor or payer authorization and reactions target the split", () => {
  const { billing, database } = makeBilling();
  const created = billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess"] },
    context(database),
  );
  const billTag = created.emissions[0].tag;
  if (!billTag) throw new Error("split emission must have a delivery tag");
  billing.sent(billTag, "split-guid", NOW + 1, created.emissions[0].key);
  expect(billing.hasOpen("chat-1")).toBe(true);

  const payerReported = billing.execute(
    "mark_paid",
    { person: "jess" },
    context(database, "minh", NOW + 2),
  );
  expect(payerReported.data).toEqual({ billId: 1, handle: "jess", paid: true });

  const denied = billing.execute(
    "mark_paid",
    { handle: "jess" },
    context(database, "alex", NOW + 3),
  );
  expect(denied.data).toEqual({
    error: "Only that debtor or the payer can report this payment.",
  });

  const wrongTarget = billing.handleReaction(
    context(database, "alex", NOW + 3),
    {
      id: "reaction-1",
      chatId: "chat-1",
      handle: "alex",
      text: "",
      at: NOW + 3,
      isFromMe: false,
      isGroup: true,
      kind: "reaction",
      reaction: { targetId: "other-message", emoji: "👍", removed: false },
    },
  );
  expect(wrongTarget).toBeNull();

  const paid = billing.handleReaction(context(database, "alex", NOW + 4), {
    id: "reaction-2",
    chatId: "chat-1",
    handle: "alex",
    text: "",
    at: NOW + 4,
    isFromMe: false,
    isGroup: true,
    kind: "reaction",
    reaction: { targetId: "split-guid", emoji: "👍", removed: false },
  });
  expect(paid?.data).toEqual({ billId: 1, handle: "alex", paid: true });
});

test("reminders are individual, capped at two, and marked only after sent", () => {
  const { billing, database } = makeBilling();
  billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess"] },
    context(database),
  );
  const first = billing.tick(
    context(database, "minh", NOW + 24 * 60 * 60 * 1000),
  );
  expect(first.emissions).toHaveLength(2);
  expect(
    billing.tick(context(database, "minh", NOW + 24 * 60 * 60 * 1000))
      .emissions,
  ).toHaveLength(0);
  const alexNudge = first.emissions.find((emission) =>
    emission.text.includes("@Alex"),
  );
  if (!alexNudge?.tag)
    throw new Error("Alex reminder must have a delivery tag");
  billing.execute(
    "mark_paid",
    {},
    context(database, "alex", NOW + 24 * 60 * 60 * 1000 + 1),
  );
  expect(
    billing.isDeliverable(
      alexNudge.tag,
      NOW + 24 * 60 * 60 * 1000 + 2,
      alexNudge.key,
    ),
  ).toBe(false);
  for (const emission of first.emissions) {
    if (
      emission.tag &&
      billing.isDeliverable(
        emission.tag,
        NOW + 24 * 60 * 60 * 1000 + 2,
        emission.key,
      )
    ) {
      const sentAt = NOW + 24 * 60 * 60 * 1000 + 3;
      billing.sent(emission.tag, undefined, sentAt, emission.key);
      billing.sent(emission.tag, undefined, sentAt + 1, emission.key);
    }
  }
  const second = billing.tick(
    context(database, "minh", NOW + 3 * 24 * 60 * 60 * 1000),
  );
  expect(second.emissions).toHaveLength(1);
  expect(second.emissions[0].text).toContain("@Jess");
  expect(second.emissions[0].text).toContain("$16.67");
});
test("queued split and reminder events become stale after correction or settlement", () => {
  const { billing, database } = makeBilling();
  const created = billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess"] },
    context(database),
  );
  const split = created.emissions[0];
  if (!split?.tag) throw new Error("split emission must have a delivery tag");
  expect(billing.isDeliverable(split.tag, NOW, split.key)).toBe(true);
  billing.sent(split.tag, "split-guid", NOW + 1, split.key);
  billing.execute("mark_paid", {}, context(database, "alex", NOW + 2));

  const firstNudge = billing.tick(
    context(database, "minh", NOW + 24 * 60 * 60 * 1000),
  ).emissions[0];
  if (!firstNudge?.tag) throw new Error("reminder must have a delivery tag");
  expect(firstNudge.text).toContain("$16.67");
  expect(
    billing.isDeliverable(
      firstNudge.tag,
      NOW + 24 * 60 * 60 * 1000 + 1,
      firstNudge.key,
    ),
  ).toBe(true);

  const correction = billing.execute(
    "adjust_share",
    { handle: "jess", amount: 8 },
    context(database, "jess", NOW + 24 * 60 * 60 * 1000 + 2),
  );
  expect(
    billing.isDeliverable(split.tag, NOW + 24 * 60 * 60 * 1000 + 3, split.key),
  ).toBe(false);
  expect(
    billing.isDeliverable(
      firstNudge.tag,
      NOW + 24 * 60 * 60 * 1000 + 3,
      firstNudge.key,
    ),
  ).toBe(false);
  billing.sent(
    firstNudge.tag,
    undefined,
    NOW + 24 * 60 * 60 * 1000 + 3,
    firstNudge.key,
  );

  const currentNudge = billing.tick(
    context(database, "minh", NOW + 24 * 60 * 60 * 1000 + 4),
  ).emissions[0];
  if (!currentNudge?.tag)
    throw new Error("corrected reminder must have a delivery tag");
  expect(currentNudge.text).toContain("$8.00");
  expect(
    billing.isDeliverable(
      currentNudge.tag,
      NOW + 24 * 60 * 60 * 1000 + 5,
      currentNudge.key,
    ),
  ).toBe(true);

  const currentSplit = correction.emissions[0];
  if (!currentSplit?.tag)
    throw new Error("corrected split must have a delivery tag");
  expect(
    billing.isDeliverable(
      currentSplit.tag,
      NOW + 24 * 60 * 60 * 1000 + 5,
      currentSplit.key,
    ),
  ).toBe(true);
  billing.execute(
    "settle_bill",
    {},
    context(database, "minh", NOW + 24 * 60 * 60 * 1000 + 6),
  );
  expect(
    billing.isDeliverable(
      currentSplit.tag,
      NOW + 24 * 60 * 60 * 1000 + 7,
      currentSplit.key,
    ),
  ).toBe(false);
});
test("settle and forgive are payer-only, and payer forgiveness is recorded", () => {
  const { billing, database } = makeBilling();
  billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex", "jess"] },
    context(database),
  );

  const deniedSettle = billing.execute(
    "settle_bill",
    {},
    context(database, "alex", NOW + 1),
  );
  const deniedForgive = billing.execute(
    "forgive_share",
    { handle: "jess" },
    context(database, "alex", NOW + 1),
  );
  expect(deniedSettle.data).toEqual({
    error: "Only the payer can settle this bill.",
  });
  expect(deniedForgive.data).toEqual({
    error: "Only the payer can forgive a share.",
  });

  const unchanged = billing.snapshot("chat-1") as {
    bills: Array<{
      status: string;
      shares: Array<{
        handle: string;
        paidAt: number | null;
        forgivenAt: number | null;
      }>;
    }>;
  };
  expect(unchanged.bills[0].status).toBe("open");
  expect(
    unchanged.bills[0].shares.find((share) => share.handle === "jess"),
  ).toMatchObject({
    paidAt: null,
    forgivenAt: null,
  });

  const forgiveness = billing.execute(
    "forgive_share",
    { handle: "alex" },
    context(database, "minh", NOW + 2),
  );
  expect(forgiveness.data).toEqual({
    billId: 1,
    handle: "alex",
    forgiven: true,
  });
  const finalForgiveness = billing.execute(
    "forgive_share",
    { handle: "jess" },
    context(database, "minh", NOW + 3),
  );
  expect(finalForgiveness.emissions[0]?.text).toContain("All settled");
  const settled = billing.snapshot("chat-1") as {
    bills: Array<{
      status: string;
      shares: Array<{
        handle: string;
        amountCents: number;
        fixed: boolean;
        paidAt: number | null;
        forgivenAt: number | null;
      }>;
    }>;
  };
  expect(settled.bills[0].status).toBe("settled");
  expect(
    settled.bills[0].shares.filter((share) => share.handle !== "minh"),
  ).toEqual([
    {
      handle: "alex",
      amountCents: 1_667,
      fixed: false,
      paidAt: NOW + 2,
      forgivenAt: NOW + 2,
    },
    {
      handle: "jess",
      amountCents: 1_667,
      fixed: false,
      paidAt: NOW + 3,
      forgivenAt: NOW + 3,
    },
  ]);
});

test("split omits payer payment links when no handle is configured", () => {
  const { billing, database } = makeBilling();
  const noLinkParticipants = participants.map((participant) =>
    participant.handle === "minh"
      ? { handle: participant.handle, name: participant.name }
      : participant,
  );

  const result = billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex"] },
    context(database, "minh", NOW, null, "chat-1", noLinkParticipants),
  );
  const splitText = result.emissions[0]?.text ?? "";
  expect(splitText).not.toContain("Venmo:");
  expect(splitText).not.toContain("Zelle:");
});

test("file-backed bills and reminders persist across instances without crossing chats", () => {
  const directory = mkdtempSync(join(tmpdir(), "miamigo-billing-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "bills.sqlite");
  const originalDatabase = new Database(path);
  databases.push(originalDatabase);
  const originalBilling = new Billing(originalDatabase);
  originalBilling.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex"], label: "first cafe" },
    context(originalDatabase, "minh", NOW, null, "chat-1"),
  );
  originalBilling.execute(
    "split_bill",
    { total: 36, people: ["minh", "alex"], label: "second cafe" },
    context(originalDatabase, "minh", NOW, null, "chat-2"),
  );

  const originalIndex = databases.indexOf(originalDatabase);
  if (originalIndex !== -1) {
    databases.splice(originalIndex, 1);
  }
  originalDatabase.close();

  const reopenedDatabase = new Database(path);
  databases.push(reopenedDatabase);
  const freshBilling = new Billing(reopenedDatabase);
  const firstChat = freshBilling.snapshot("chat-1") as {
    bills: Array<{ label: string }>;
  };
  const secondChat = freshBilling.snapshot("chat-2") as {
    bills: Array<{ label: string }>;
  };
  const emptyChat = freshBilling.snapshot("chat-3") as { bills: unknown[] };
  expect(firstChat.bills.map((bill) => bill.label)).toEqual(["first cafe"]);
  expect(secondChat.bills.map((bill) => bill.label)).toEqual(["second cafe"]);
  expect(emptyChat.bills).toHaveLength(0);

  const dueAt = NOW + 24 * 60 * 60 * 1000;
  const firstReminder = freshBilling.tick(
    context(reopenedDatabase, "minh", dueAt, null, "chat-1"),
  );
  const secondReminder = freshBilling.tick(
    context(reopenedDatabase, "minh", dueAt, null, "chat-2"),
  );
  expect(firstReminder.emissions).toHaveLength(1);
  expect(firstReminder.emissions[0].text).toContain("first cafe");
  expect(firstReminder.emissions[0].text).toContain("$25.00");
  expect(secondReminder.emissions).toHaveLength(1);
  expect(secondReminder.emissions[0].text).toContain("second cafe");
  expect(secondReminder.emissions[0].text).toContain("$18.00");
});

test("payer-only settle emits final settled exactly once", () => {
  const { billing, database } = makeBilling();
  billing.execute(
    "split_bill",
    { total: 50, people: ["minh", "alex"] },
    context(database),
  );
  const settled = billing.execute("settle_bill", {}, context(database));
  expect(settled.emissions).toHaveLength(1);
  expect(settled.emissions[0].text).toContain("All settled");
  const repeated = billing.execute("settle_bill", {}, context(database));
  expect(repeated.emissions).toHaveLength(0);
  expect(repeated.data).toEqual({ error: "There is no open bill." });
});
