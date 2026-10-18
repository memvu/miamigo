import type { Database } from "bun:sqlite";
import type {
  ActionResult,
  ChatContext,
  Classification,
  DeliveryTag,
  Emission,
  IncomingMessage,
  Participant,
  ToolDefinition,
} from "./contracts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BILL_CONFIDENCE = 0.8;
const PAYMENT_EMOJIS = new Set(["👍", "‼️", "‼"]);

type FixedShares = Record<string, number>;

type SplitBillRow = {
  id: number;
  chat_id: string;
  plan_id: number | null;
  payer_handle: string;
  total_cents: number;
  tip_cents: number;
  label: string;
  split_msg_guid: string | null;
  status: "open" | "settled" | "cancelled";
  created_at: number;
  nudges_sent: number;
  tip_state: "pending" | "resolved";
  people_json: string;
  fixed_json: string;
  settled_notice_sent: number;
  split_revision: number;
};

type ShareRow = {
  bill_id: number;
  handle: string;
  amount_cents: number;
  fixed: number;
  paid_at: number | null;
  forgiven_at: number | null;
};

type ReminderRow = {
  id: number;
  bill_id: number;
  handle: string;
  stage: 1 | 2;
  due_at: number;
  sent_at: number | null;
};

export interface SplitResult {
  [handle: string]: number;
}

function splitEventKey(
  bill: Pick<SplitBillRow, "id" | "split_revision">,
): string {
  return `bill:${bill.id}:split:${bill.split_revision}`;
}

function nudgeEventKey(
  billId: number,
  stage: 1 | 2,
  handle: string,
  revision: number,
  amountCents: number,
): string {
  return `bill:${billId}:nudge:${stage}:${handle}:${revision}:${amountCents}`;
}

/**
 * Split an integer-cent total without ever losing or creating a cent.
 * Fixed amounts are kept as-is and the remainder is divided among everyone
 * else. Extra cents are assigned to non-payers first, in input order.
 */
export function splitBill(
  totalCents: number,
  people: string[],
  fixedShares: FixedShares = {},
  payer?: string,
): SplitResult {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new RangeError("totalCents must be a non-negative integer");
  }
  if (people.length === 0) {
    throw new RangeError("at least one person is required");
  }

  const normalizedPeople = people.map((person) => person.trim());
  if (normalizedPeople.some((person) => person.length === 0)) {
    throw new RangeError("people must contain non-empty identifiers");
  }
  if (new Set(normalizedPeople).size !== normalizedPeople.length) {
    throw new RangeError("people must not contain duplicates");
  }
  if (payer !== undefined && !normalizedPeople.includes(payer)) {
    throw new RangeError("payer must be included in people");
  }

  const knownPeople = new Set(normalizedPeople);
  let fixedTotal = 0;
  for (const [handle, amount] of Object.entries(fixedShares)) {
    if (!knownPeople.has(handle)) {
      throw new RangeError(`fixed share has unknown person: ${handle}`);
    }
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new RangeError("fixed shares must be non-negative integer cents");
    }
    fixedTotal += amount;
    if (!Number.isSafeInteger(fixedTotal)) {
      throw new RangeError("fixed shares exceed safe integer range");
    }
  }
  if (fixedTotal > totalCents) {
    throw new RangeError("fixed shares exceed total");
  }

  const shares: SplitResult = {};
  for (const [handle, amount] of Object.entries(fixedShares)) {
    shares[handle] = amount;
  }

  const unfixed = normalizedPeople.filter((person) => !(person in fixedShares));
  if (unfixed.length === 0) {
    if (fixedTotal !== totalCents) {
      throw new RangeError("fixed shares must conserve the total");
    }
    return shares;
  }

  const remaining = totalCents - fixedTotal;
  const each = Math.floor(remaining / unfixed.length);
  const remainder = remaining % unfixed.length;
  const allocationOrder = [
    ...unfixed.filter((person) => person !== payer),
    ...unfixed.filter((person) => person === payer),
  ];
  for (const [index, handle] of allocationOrder.entries()) {
    shares[handle] = each + (index < remainder ? 1 : 0);
  }
  return shares;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function parseDollars(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    value = value.toString();
  }
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }
  const [whole, fraction = ""] = cleaned.split(".");
  const cents = Number(`${whole}${fraction.padEnd(2, "0")}`);
  return Number.isSafeInteger(cents) ? cents : null;
}

function parseCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const cents = Number(value.trim());
    return Number.isSafeInteger(cents) ? cents : null;
  }
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function participantByIdentity(
  identifier: string,
  participants: Participant[],
): { handle: string } | { error: string } {
  const normalized = identifier.trim().replace(/^@/, "").toLowerCase();
  if (!normalized) {
    return { error: "An identity is required." };
  }
  const handleMatch = participants.filter(
    (participant) => participant.handle.toLowerCase() === normalized,
  );
  if (handleMatch.length === 1) {
    return { handle: handleMatch[0].handle };
  }
  if (handleMatch.length > 1) {
    return { error: `Identity ${identifier} is ambiguous.` };
  }
  const nameMatches = participants.filter(
    (participant) => participant.name.trim().toLowerCase() === normalized,
  );
  if (nameMatches.length === 1) {
    return { handle: nameMatches[0].handle };
  }
  if (nameMatches.length > 1) {
    return { error: `Name ${identifier} is ambiguous.` };
  }
  return { error: `I don't know participant ${identifier}.` };
}

function displayName(handle: string, participants: Participant[]): string {
  return (
    participants.find((participant) => participant.handle === handle)?.name ||
    handle
  );
}

function participantMatchesText(
  hint: string,
  participant: Participant,
): boolean {
  const escaped = [participant.name, participant.handle]
    .filter(Boolean)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return escaped.some((value) =>
    new RegExp(`(?:^|[^a-z0-9])@?${value}(?:$|[^a-z0-9])`, "i").test(hint),
  );
}

interface ResolvedPeople {
  people: string[];
  error?: string;
}

function resolveSplitHint(
  hint: string | null | undefined,
  participants: Participant[],
  payer: string | null,
): ResolvedPeople {
  const all = participants.map((participant) => participant.handle);
  if (!hint?.trim()) {
    return { people: all };
  }
  const text = hint.trim();
  const lower = text.toLowerCase();
  const countMatch = lower.match(/\b(\d+)\s*(?:ways?|people|persons?)\b/);
  const count = countMatch ? Number(countMatch[1]) : null;
  const everybody = /\b(?:everyone|everybody|all)\b/.test(lower);
  const excluded = new Set<string>();
  const exclusionMatch =
    lower.match(
      /(?:didn['’]?t\s+come|did\s+not\s+come|not\s+coming|except|without)\s+(.+)/,
    ) ??
    lower.match(/(.+?)\s+(?:didn['’]?t\s+come|did\s+not\s+come|not\s+coming)/);
  if (exclusionMatch) {
    for (const participant of participants) {
      if (participantMatchesText(exclusionMatch[1], participant)) {
        excluded.add(participant.handle);
      }
    }
  }
  if (payer && excluded.has(payer)) {
    return { people: [], error: "The payer cannot be excluded from a split." };
  }

  const explicit: string[] = [];
  const mentionedNames = new Set<string>();
  for (const participant of participants) {
    if (participantMatchesText(text, participant)) {
      const normalizedName = participant.name.trim().toLowerCase();
      if (mentionedNames.has(normalizedName)) {
        return { people: [], error: `Name ${participant.name} is ambiguous.` };
      }
      mentionedNames.add(normalizedName);
      explicit.push(participant.handle);
    }
  }
  if (/\b(?:me|myself|i)\b/.test(lower) && payer) {
    explicit.push(payer);
  }
  const selected = unique(explicit).filter((handle) => !excluded.has(handle));
  if ((selected.length > 0 || count !== null) && !everybody) {
    let remainder = lower;
    for (const participant of participants) {
      remainder = remainder
        .replaceAll(participant.name.toLowerCase(), " ")
        .replaceAll(participant.handle.toLowerCase(), " ");
    }
    remainder = remainder.replace(
      /\b(?:split|with|for|me|myself|i|and|the|people|person|ways?|way|everyone|everybody|didn['’]?t|did|not|coming|come|except|without)\b/g,
      " ",
    );
    if (/[a-z]/i.test(remainder.replace(/[,;@]/g, " "))) {
      return {
        people: [],
        error: "I need identities that are known in this chat.",
      };
    }
  }
  if (exclusionMatch && selected.length === 0 && count === null) {
    return { people: all.filter((handle) => !excluded.has(handle)) };
  }

  if (everybody) {
    return {
      people: all.filter((handle) => !excluded.has(handle)),
      ...(count !== null && count !== all.length
        ? {
            error: "The participant count does not match everyone in the chat.",
          }
        : {}),
    };
  }

  if (count !== null) {
    if (count <= 0 || count > all.length || selected.length > count) {
      return {
        people: [],
        error: "That split count does not match known participants.",
      };
    }
    const result = [...selected];
    const preferred = [
      ...(payer && !excluded.has(payer) ? [payer] : []),
      ...all,
    ];
    for (const handle of preferred) {
      if (result.length >= count) {
        break;
      }
      if (!excluded.has(handle) && !result.includes(handle)) {
        result.push(handle);
      }
    }
    return result.length === count
      ? { people: result }
      : {
          people: [],
          error: "I could not find enough known participants for that split.",
        };
  }

  if (payer && !excluded.has(payer) && !selected.includes(payer)) {
    selected.unshift(payer);
  }
  return selected.length > 0
    ? { people: selected }
    : { people: [], error: "I need the participant names for this split." };
}

function parseIdentityList(
  value: unknown,
  participants: Participant[],
): { handles: string[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      handles: [],
      error: "At least one known participant is required.",
    };
  }
  const handles: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return { handles: [], error: "Participant identities must be text." };
    }
    const resolved = participantByIdentity(item, participants);
    if ("error" in resolved) {
      return { handles: [], error: resolved.error };
    }
    handles.push(resolved.handle);
  }
  const uniqueHandles = unique(handles);
  return uniqueHandles.length === handles.length
    ? { handles: uniqueHandles }
    : { handles: [], error: "A participant cannot be listed twice." };
}

function parseFixedShares(
  value: unknown,
  participants: Participant[],
): { fixed: FixedShares; error?: string } {
  if (value === undefined || value === null) {
    return { fixed: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      fixed: {},
      error: "Fixed shares must be an identity-to-amount object.",
    };
  }
  const fixed: FixedShares = {};
  for (const [identity, amount] of Object.entries(value)) {
    const resolved = participantByIdentity(identity, participants);
    if ("error" in resolved) {
      return { fixed: {}, error: resolved.error };
    }
    const cents = parseDollars(amount);
    if (cents === null) {
      return { fixed: {}, error: `Invalid fixed share for ${identity}.` };
    }
    fixed[resolved.handle] = cents;
  }
  return { fixed };
}

function resultError(message: string): ActionResult {
  return { emissions: [], data: { error: message } };
}

export class Billing {
  private readonly db: Database;
  private readonly pendingDeliveries = new Set<string>();

  constructor(db: Database) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        plan_id INTEGER,
        payer_handle TEXT NOT NULL,
        total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
        tip_cents INTEGER NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
        label TEXT NOT NULL DEFAULT 'shared expense',
        split_msg_guid TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','cancelled')),
        created_at INTEGER NOT NULL,
        nudges_sent INTEGER NOT NULL DEFAULT 0,
        tip_state TEXT NOT NULL DEFAULT 'resolved' CHECK (tip_state IN ('pending','resolved')),
        people_json TEXT NOT NULL DEFAULT '[]',
        fixed_json TEXT NOT NULL DEFAULT '{}',
        settled_notice_sent INTEGER NOT NULL DEFAULT 0,
        split_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bill_shares (
        bill_id INTEGER NOT NULL,
        handle TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        fixed INTEGER NOT NULL DEFAULT 0,
        paid_at INTEGER,
        forgiven_at INTEGER,
        PRIMARY KEY (bill_id, handle),
        FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS bill_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bill_id INTEGER NOT NULL,
        handle TEXT NOT NULL,
        stage INTEGER NOT NULL CHECK (stage IN (1, 2)),
        due_at INTEGER NOT NULL,
        sent_at INTEGER,
        UNIQUE (bill_id, handle, stage),
        FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE
      );
    `);
    const billColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(bills)")
      .all();
    if (!billColumns.some((column) => column.name === "split_revision")) {
      this.db.exec(
        "ALTER TABLE bills ADD COLUMN split_revision INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  snapshot(chatId: string): unknown {
    const bills = this.db
      .query<SplitBillRow, [string]>(
        "SELECT * FROM bills WHERE chat_id = ? ORDER BY id DESC",
      )
      .all(chatId);
    return {
      bills: bills.map((bill) => ({
        id: bill.id,
        planId: bill.plan_id,
        payerHandle: bill.payer_handle,
        totalCents: bill.total_cents,
        tipCents: bill.tip_cents,
        totalWithTipCents: bill.total_cents + bill.tip_cents,
        label: bill.label,
        splitMessageGuid: bill.split_msg_guid,
        status: bill.status,
        createdAt: bill.created_at,
        tipPending: bill.tip_state === "pending",
        shares: this.sharesFor(bill.id).map((share) => ({
          handle: share.handle,
          amountCents: share.amount_cents,
          fixed: Boolean(share.fixed),
          paidAt: share.paid_at,
          forgivenAt: share.forgiven_at,
        })),
      })),
    };
  }
  hasOpen(chatId: string): boolean {
    return (
      this.latestOpenBill(chatId) !== null ||
      this.latestPendingTip(chatId) !== null
    );
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    switch (name) {
      case "split_bill":
        return this.executeSplit(args, ctx);
      case "mark_paid":
        return this.markPaidCommand(args, ctx);
      case "adjust_share":
        return this.adjustShareCommand(args, ctx);
      case "get_balances":
        return this.balances(ctx);
      case "settle_bill":
        return this.settleBill(ctx);
      case "forgive_share":
        return this.forgiveShare(args, ctx);
      default:
        return resultError(`Unknown billing action: ${name}`);
    }
  }
  handleMessage(
    ctx: ChatContext,
    message: IncomingMessage,
  ): ActionResult | null {
    if (message.chatId !== ctx.chatId || message.isFromMe || message.reaction) {
      return null;
    }
    const actor = this.resolveActor(ctx, message.handle);
    if (!actor) {
      return null;
    }

    const pending = this.latestPendingTip(ctx.chatId);
    if (pending && this.isTipAnswer(message.text)) {
      return this.answerTip(pending, message.text, ctx);
    }

    const payerBill = this.latestOpenBill(ctx.chatId);
    if (payerBill && actor === payerBill.payer_handle) {
      const reportedIdentities = ctx.participants.filter(
        (participant) =>
          participant.handle !== payerBill.payer_handle &&
          participantMatchesText(message.text, participant),
      );
      const reportedIdentity =
        reportedIdentities.length === 1 ? reportedIdentities[0] : undefined;
      if (
        reportedIdentity &&
        /\b(?:paid|sent|venmo['’]?d|zelle['’]?d|transferred)\b/i.test(
          message.text,
        )
      ) {
        return this.markSharePaid(
          payerBill.id,
          reportedIdentity.handle,
          ctx.now,
        );
      }
    }

    if (
      /\b(?:haven['’]?t|have\s+not|didn['’]?t|did\s+not|not)\s+(?:paid|sent|venmo['’]?d|zelle['’]?d)/i.test(
        message.text,
      )
    ) {
      return null;
    }
    if (
      !/\b(?:paid|sent|venmo['’]?d|zelle['’]?d|transferred)\b/i.test(
        message.text,
      )
    ) {
      return null;
    }
    const bill = this.latestOpenBillFor(ctx.chatId, actor);
    if (!bill) {
      return null;
    }
    return this.markSharePaid(bill.id, actor, ctx.now);
  }

  observe(ctx: ChatContext, decision: Classification): ActionResult | null {
    const bill = decision.bill;
    if (!bill || bill.confidence < BILL_CONFIDENCE) {
      return null;
    }
    const existing = this.latestOpenBill(ctx.chatId);
    if (!existing) {
      return null;
    }
    let result: ActionResult | null = null;
    const paymentResult = this.observePayments(ctx, existing.id, bill.paid_by);
    if (paymentResult) {
      result = paymentResult;
    }
    const correctionResult = this.observeCorrections(
      ctx,
      existing.id,
      bill.fixed_shares,
    );
    if (correctionResult) {
      result = this.combine(result, correctionResult);
    }
    return result;
  }

  handleReaction(
    ctx: ChatContext,
    message: IncomingMessage,
  ): ActionResult | null {
    const reaction = message.reaction;
    if (
      message.chatId !== ctx.chatId ||
      message.isFromMe ||
      !reaction ||
      reaction.removed ||
      !PAYMENT_EMOJIS.has(reaction.emoji)
    ) {
      return null;
    }
    const participant = this.resolveActor(ctx, message.handle);
    if (!participant) {
      return null;
    }
    const bill = this.db
      .query<SplitBillRow, [string, string]>(
        "SELECT * FROM bills WHERE chat_id = ? AND split_msg_guid = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
      )
      .get(ctx.chatId, reaction.targetId);
    if (!bill || participant === bill.payer_handle) {
      return null;
    }
    return this.markSharePaid(bill.id, participant, ctx.now);
  }

  tick(ctx: ChatContext): ActionResult {
    const reminders = this.db
      .query<
        ReminderRow & SplitBillRow & { amount_cents: number },
        [string, number]
      >(
        `SELECT r.id, r.bill_id, r.handle, r.stage, r.due_at, r.sent_at,
                b.chat_id, b.payer_handle, b.label, b.status, b.total_cents,
                b.tip_cents, b.created_at, b.nudges_sent, b.tip_state,
                b.plan_id, b.split_msg_guid, b.people_json, b.fixed_json,
                b.settled_notice_sent, b.split_revision, s.amount_cents
           FROM bill_reminders r
           JOIN bills b ON b.id = r.bill_id
           JOIN bill_shares s ON s.bill_id = r.bill_id AND s.handle = r.handle
          WHERE b.chat_id = ? AND b.status = 'open' AND r.due_at <= ?
            AND r.sent_at IS NULL AND s.paid_at IS NULL
          ORDER BY r.due_at, r.id`,
      )
      .all(ctx.chatId, ctx.now);
    const emissions: Emission[] = [];
    for (const reminder of reminders) {
      const amountCents = reminder.amount_cents;
      const key = nudgeEventKey(
        reminder.bill_id,
        reminder.stage,
        reminder.handle,
        reminder.split_revision,
        amountCents,
      );
      if (this.pendingDeliveries.has(key)) {
        continue;
      }
      this.pendingDeliveries.add(key);
      const payer = this.displayForChat(
        reminder.payer_handle,
        ctx.participants,
      );
      const debtor = this.displayForChat(reminder.handle, ctx.participants);
      emissions.push({
        chatId: ctx.chatId,
        key,
        tag: { kind: "bill_nudge", id: reminder.id },
        text: `💸 Friendly reminder: @${debtor} still owes @${payer} ${money(amountCents)} for ${reminder.label} 🍜`,
      });
    }
    return { emissions };
  }
  isDeliverable(tag: DeliveryTag, now: number, eventKey?: string): boolean {
    if (!Number.isFinite(now) || !eventKey) {
      return false;
    }
    if (tag.kind === "bill") {
      const bill = this.billById(tag.id);
      const activeSplit =
        bill?.status === "open" ||
        (bill?.status === "settled" &&
          bill.split_revision === 0 &&
          bill.settled_notice_sent === 1);
      return Boolean(
        bill &&
          activeSplit &&
          bill.tip_state === "resolved" &&
          eventKey === splitEventKey(bill),
      );
    }
    if (tag.kind !== "bill_nudge") {
      return false;
    }
    const reminder = this.db
      .query<
        ReminderRow & {
          status: string;
          amount_cents: number;
          paid_at: number | null;
          split_revision: number;
        },
        [number]
      >(
        `SELECT r.*, b.status, b.split_revision, s.amount_cents, s.paid_at
           FROM bill_reminders r
           JOIN bills b ON b.id = r.bill_id
           JOIN bill_shares s ON s.bill_id = r.bill_id AND s.handle = r.handle
          WHERE r.id = ?`,
      )
      .get(tag.id);
    const deliverable =
      reminder !== null &&
      reminder.sent_at === null &&
      reminder.due_at <= now &&
      reminder.status === "open" &&
      reminder.amount_cents > 0 &&
      reminder.paid_at === null &&
      eventKey ===
        nudgeEventKey(
          reminder.bill_id,
          reminder.stage,
          reminder.handle,
          reminder.split_revision,
          reminder.amount_cents,
        );
    if (!deliverable) {
      this.pendingDeliveries.delete(eventKey);
    }
    return deliverable;
  }

  sent(
    tag: DeliveryTag,
    guid: string | undefined,
    now: number,
    eventKey?: string,
  ): void {
    if (tag.kind === "bill") {
      const bill = this.billById(tag.id);
      if (!bill || !eventKey || !this.isDeliverable(tag, now, eventKey)) {
        return;
      }
      if (guid) {
        this.db
          .query("UPDATE bills SET split_msg_guid = ? WHERE id = ?")
          .run(guid, tag.id);
      }
      return;
    }
    if (tag.kind !== "bill_nudge" || !eventKey) {
      return;
    }
    if (!this.isDeliverable(tag, now, eventKey)) {
      return;
    }
    const reminder = this.db
      .query<ReminderRow, [number]>("SELECT * FROM bill_reminders WHERE id = ?")
      .get(tag.id);
    if (!reminder) {
      return;
    }
    this.pendingDeliveries.delete(eventKey);
    this.db
      .query(
        "UPDATE bill_reminders SET sent_at = ? WHERE id = ? AND sent_at IS NULL",
      )
      .run(now, tag.id);
    this.db
      .query(
        "UPDATE bills SET nudges_sent = (SELECT COUNT(*) FROM bill_reminders WHERE bill_id = ? AND sent_at IS NOT NULL) WHERE id = ?",
      )
      .run(reminder.bill_id, reminder.bill_id);
  }

  forget(chatId: string): void {
    const billIds = this.db
      .query<{ id: number }, [string]>("SELECT id FROM bills WHERE chat_id = ?")
      .all(chatId)
      .map((bill) => bill.id);
    for (const id of billIds) {
      for (const key of this.pendingDeliveries) {
        if (key.startsWith(`bill:${id}:`)) {
          this.pendingDeliveries.delete(key);
        }
      }
    }
    this.db
      .query(
        "DELETE FROM bill_reminders WHERE bill_id IN (SELECT id FROM bills WHERE chat_id = ?)",
      )
      .run(chatId);
    this.db
      .query(
        "DELETE FROM bill_shares WHERE bill_id IN (SELECT id FROM bills WHERE chat_id = ?)",
      )
      .run(chatId);
    this.db.query("DELETE FROM bills WHERE chat_id = ?").run(chatId);
  }

  private executeSplit(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const totalCents = parseDollars(args.total ?? args.total_dollars);
    if (totalCents === null) {
      return resultError(
        "The bill total must be a non-negative amount with at most two cents.",
      );
    }
    const payer =
      args.payer === undefined
        ? ctx.actor
        : this.resolveOptionalIdentity(args.payer, ctx);
    if (!payer || !this.hasParticipant(ctx.participants, payer)) {
      return resultError("The payer must be a known participant.");
    }
    const hint =
      typeof args.split_hint === "string" ? args.split_hint : undefined;
    let people: string[];
    if (Array.isArray(args.people)) {
      const parsed = parseIdentityList(args.people, ctx.participants);
      if (parsed.error) {
        return resultError(parsed.error);
      }
      people = parsed.handles;
    } else if (hint) {
      const resolved = resolveSplitHint(hint, ctx.participants, payer);
      if (resolved.error) {
        return resultError(resolved.error);
      }
      people = resolved.people;
    } else {
      people = this.planPeopleWithinSixHours(ctx, payer).people;
    }
    if (!people.includes(payer)) {
      people = [payer, ...people];
    }
    const fixed = parseFixedShares(args.fixed_shares, ctx.participants);
    if (fixed.error) {
      return resultError(fixed.error);
    }
    if (Object.keys(fixed.fixed).some((handle) => !people.includes(handle))) {
      return resultError(
        "Every fixed share must belong to the split participants.",
      );
    }
    const tipMode = args.includes_tip === "no" ? "pending" : "resolved";
    const label =
      this.cleanLabel(args.label) ?? ctx.plan?.location ?? "shared expense";
    return this.createBill(
      ctx,
      payer,
      totalCents,
      people,
      fixed.fixed,
      label,
      tipMode,
    );
  }

  private planPeopleWithinSixHours(
    ctx: ChatContext,
    payer: string,
  ): ResolvedPeople {
    const plan = ctx.plan;
    if (!plan || (plan.stage !== "locked" && plan.stage !== "done")) {
      return {
        people: ctx.participants.map((participant) => participant.handle),
      };
    }
    const eventAt = plan.startsAt ?? plan.lockedAt;
    if (
      eventAt === null ||
      ctx.now < eventAt ||
      ctx.now - eventAt > 6 * HOUR_MS ||
      plan.going.length === 0
    ) {
      return {
        people: ctx.participants.map((participant) => participant.handle),
      };
    }
    const knownGoing = plan.going.filter((handle) =>
      this.hasParticipant(ctx.participants, handle),
    );
    if (knownGoing.length === 0) {
      return {
        people: ctx.participants.map((participant) => participant.handle),
      };
    }
    if (!knownGoing.includes(payer)) {
      knownGoing.unshift(payer);
    }
    return { people: unique(knownGoing) };
  }

  private createBill(
    ctx: ChatContext,
    payer: string,
    totalCents: number,
    people: string[],
    fixed: FixedShares,
    label: string,
    tipState: "pending" | "resolved",
  ): ActionResult {
    if (!people.includes(payer)) {
      return resultError(
        "The payer must be included in the split participants.",
      );
    }
    let shares: SplitResult | null = null;
    if (tipState === "resolved") {
      try {
        shares = splitBill(totalCents, people, fixed, payer);
      } catch (error) {
        return resultError(
          error instanceof Error ? error.message : "Invalid split.",
        );
      }
    }
    const persistBill = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO bills
            (chat_id, plan_id, payer_handle, total_cents, label, status, created_at,
             tip_state, people_json, fixed_json)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        )
        .run(
          ctx.chatId,
          ctx.plan?.id ?? null,
          payer,
          totalCents,
          label,
          ctx.now,
          tipState,
          JSON.stringify(people),
          JSON.stringify(fixed),
        );
      const row = this.latestBill(ctx.chatId);
      if (!row) {
        throw new Error("The bill could not be persisted.");
      }
      if (tipState === "resolved") {
        this.materializeShares(row, shares ?? {});
      }
      return row;
    });
    let row: SplitBillRow;
    try {
      row = persistBill();
    } catch (error) {
      return resultError(
        error instanceof Error
          ? error.message
          : "The bill could not be persisted.",
      );
    }
    if (tipState === "pending") {
      return {
        emissions: [
          {
            chatId: ctx.chatId,
            key: `bill:${row.id}:tip-question`,
            text: "🤔 Quick q: should I add a tip before splitting?\n1) 18%  2) 20%  3) Other amount  4) No tip",
          },
        ],
        data: { billId: row.id, tipPending: true },
      };
    }
    return this.splitResult(ctx, row.id);
  }

  private splitResult(ctx: ChatContext, billId: number): ActionResult {
    const bill = this.billById(billId);
    if (!bill) {
      return resultError("The bill could not be loaded.");
    }
    const shares = this.sharesFor(bill.id);
    this.createReminderRows(bill, shares);
    const emission = this.renderSplit(ctx, bill, shares);
    const settlement = this.settleIfComplete(bill.id, ctx.now, false);
    return {
      emissions: [emission, ...settlement],
      data: { billId: bill.id, shares: this.shareData(shares) },
    };
  }

  private materializeShares(bill: SplitBillRow, shares: SplitResult): void {
    this.db.query("DELETE FROM bill_shares WHERE bill_id = ?").run(bill.id);
    const people = this.readPeople(bill);
    for (const handle of people) {
      const amount = shares[handle];
      this.db
        .query(
          `INSERT INTO bill_shares
             (bill_id, handle, amount_cents, fixed, paid_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          bill.id,
          handle,
          amount,
          Object.hasOwn(this.readFixed(bill), handle) ? 1 : 0,
          handle === bill.payer_handle || amount === 0 ? bill.created_at : null,
        );
    }
    this.db
      .query("UPDATE bills SET tip_state = 'resolved' WHERE id = ?")
      .run(bill.id);
  }

  private createReminderRows(bill: SplitBillRow, shares: ShareRow[]): void {
    if (bill.tip_state !== "resolved") {
      return;
    }
    for (const share of shares) {
      if (share.handle === bill.payer_handle || share.amount_cents === 0) {
        continue;
      }
      this.db
        .query(
          `INSERT OR IGNORE INTO bill_reminders (bill_id, handle, stage, due_at)
           VALUES (?, ?, 1, ?), (?, ?, 2, ?)`,
        )
        .run(
          bill.id,
          share.handle,
          bill.created_at + DAY_MS,
          bill.id,
          share.handle,
          bill.created_at + 3 * DAY_MS,
        );
    }
  }

  private renderSplit(
    ctx: ChatContext,
    bill: SplitBillRow,
    shares: ShareRow[],
  ): Emission {
    const debtors = shares.filter(
      (share) => share.handle !== bill.payer_handle && share.amount_cents > 0,
    );
    const amountValues = unique(debtors.map((share) => share.amount_cents));
    const each =
      amountValues.length === 1 ? ` → ${money(amountValues[0])} each` : "";
    const payer = this.displayForChat(bill.payer_handle, ctx.participants);
    const debtorNames = debtors
      .map((share) => {
        const name = this.displayForChat(share.handle, ctx.participants);
        return amountValues.length === 1
          ? name
          : `${name} ${money(share.amount_cents)}`;
      })
      .join(", ");
    const lines = [
      `💸 Bill split: ${money(bill.total_cents + bill.tip_cents)} total, ${shares.length} people${each}`,
      `Pay back @${payer}: ${debtorNames || "nobody"}`,
    ];
    const payerParticipant = ctx.participants.find(
      (participant) => participant.handle === bill.payer_handle,
    );
    if (payerParticipant?.venmo) {
      lines.push(
        `Venmo: venmo.com/${payerParticipant.venmo.replace(/^@/, "")} · reply "paid" when done`,
      );
    } else if (payerParticipant?.zelle) {
      lines.push(`Zelle: ${payerParticipant.zelle} · reply "paid" when done`);
    }
    lines.push('(wrong total or people? reply "amigo fix")');
    return {
      chatId: ctx.chatId,
      text: lines.join("\n"),
      key: splitEventKey(bill),
      tag: { kind: "bill", id: bill.id },
    };
  }

  private balances(ctx: ChatContext): ActionResult {
    const bill = this.latestOpenOrSettledBill(ctx.chatId);
    if (!bill) {
      return { emissions: [], data: { bills: [] } };
    }
    const shares = this.sharesFor(bill.id);
    const debtors = shares.filter(
      (share) => share.handle !== bill.payer_handle && share.amount_cents > 0,
    );
    const paid = debtors.filter((share) => share.paid_at !== null).length;
    const payer = this.displayForChat(bill.payer_handle, ctx.participants);
    const lines = [
      `💸 ${bill.label} bill (${money(bill.total_cents + bill.tip_cents)}): ${paid}/${debtors.length} paid`,
    ];
    for (const share of debtors) {
      const name = this.displayForChat(share.handle, ctx.participants);
      lines.push(
        share.paid_at !== null
          ? `✅ ${name}`
          : `⏳ ${name} owes ${payer} ${money(share.amount_cents)}`,
      );
    }
    return {
      emissions: [
        {
          chatId: ctx.chatId,
          text: lines.join("\n"),
          key: `bill:${bill.id}:balances:${paid}/${debtors.length}`,
        },
      ],
      data: { billId: bill.id, shares: this.shareData(shares) },
    };
  }

  private markPaidCommand(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const bill = this.latestOpenBill(ctx.chatId);
    if (!bill) {
      return resultError("There is no open bill.");
    }
    const requested = args.handle ?? args.person ?? args.name;
    const target =
      requested === undefined
        ? ctx.actor
        : this.resolveOptionalIdentity(requested, ctx);
    if (!target) {
      return resultError("I need a known participant for /paid.");
    }
    if (ctx.actor !== bill.payer_handle && target !== ctx.actor) {
      return resultError(
        "Only that debtor or the payer can report this payment.",
      );
    }
    if (target === bill.payer_handle) {
      return resultError("The payer does not owe themselves.");
    }
    return this.markSharePaid(bill.id, target, ctx.now);
  }

  private adjustShareCommand(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const bill = this.latestOpenBill(ctx.chatId);
    if (!bill) {
      return resultError("There is no open bill.");
    }
    const target = this.resolveOptionalIdentity(
      args.handle ?? args.person ?? args.name,
      ctx,
    );
    if (!target) {
      return resultError("I need a known participant for this correction.");
    }
    if (ctx.actor !== target && ctx.actor !== bill.payer_handle) {
      return resultError("Only the debtor or payer can correct a share.");
    }
    const cents =
      args.amount_cents === undefined
        ? parseDollars(args.amount)
        : parseCents(args.amount_cents);
    if (cents === null) {
      return resultError("The corrected share must be a non-negative amount.");
    }
    return this.adjustShare(bill.id, target, cents, ctx.now, ctx);
  }

  private adjustShare(
    billId: number,
    target: string,
    cents: number,
    now: number,
    ctx: ChatContext,
  ): ActionResult {
    const bill = this.billById(billId);
    if (bill?.status !== "open") {
      return resultError("There is no open bill.");
    }
    const people = this.readPeople(bill);
    if (!people.includes(target)) {
      return resultError("That participant is not in this split.");
    }
    const oldShares = this.sharesFor(bill.id);
    const targetShare = oldShares.find((share) => share.handle === target);
    if (
      target !== bill.payer_handle &&
      targetShare &&
      targetShare.amount_cents > 0 &&
      targetShare.paid_at !== null &&
      targetShare.amount_cents !== cents
    ) {
      return resultError(
        "This share is already paid and its amount cannot be changed.",
      );
    }

    const fixed = this.readFixed(bill);
    for (const share of oldShares) {
      if (
        share.handle !== bill.payer_handle &&
        share.amount_cents > 0 &&
        share.paid_at !== null
      ) {
        fixed[share.handle] = share.amount_cents;
      }
    }
    fixed[target] = cents;
    let shares: SplitResult;
    try {
      shares = splitBill(
        bill.total_cents + bill.tip_cents,
        people,
        fixed,
        bill.payer_handle,
      );
    } catch (error) {
      return resultError(
        error instanceof Error ? error.message : "Invalid correction.",
      );
    }

    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE bills SET fixed_json = ?, split_revision = split_revision + 1, split_msg_guid = NULL WHERE id = ?",
        )
        .run(JSON.stringify(fixed), bill.id);
      for (const person of people) {
        const old = oldShares.find((share) => share.handle === person);
        this.db
          .query(
            `UPDATE bill_shares SET amount_cents = ?, fixed = ?,
               paid_at = CASE WHEN amount_cents = ? THEN paid_at ELSE NULL END,
               forgiven_at = CASE WHEN amount_cents = ? THEN forgiven_at ELSE NULL END
             WHERE bill_id = ? AND handle = ?`,
          )
          .run(
            shares[person],
            Object.hasOwn(fixed, person) ? 1 : 0,
            shares[person],
            shares[person],
            bill.id,
            person,
          );
        if (!old) {
          this.db
            .query(
              "INSERT INTO bill_shares (bill_id, handle, amount_cents, fixed) VALUES (?, ?, ?, ?)",
            )
            .run(
              bill.id,
              person,
              shares[person],
              Object.hasOwn(fixed, person) ? 1 : 0,
            );
        }
        if (shares[person] === 0) {
          this.db
            .query(
              "UPDATE bill_shares SET paid_at = COALESCE(paid_at, ?) WHERE bill_id = ? AND handle = ?",
            )
            .run(bill.created_at, bill.id, person);
        }
      }
    })();

    const settled = this.settleIfComplete(bill.id, now);
    if (settled.length > 0) {
      return {
        emissions: settled,
        data: { billId, shares: this.shareData(this.sharesFor(billId)) },
      };
    }
    const updated = this.billById(billId);
    const corrected = updated
      ? this.renderSplit(ctx, updated, this.sharesFor(billId))
      : null;
    return {
      emissions: corrected ? [corrected] : [],
      data: { billId, shares: this.shareData(this.sharesFor(billId)) },
    };
  }

  private observePayments(
    ctx: ChatContext,
    billId: number,
    paidBy: string[],
  ): ActionResult | null {
    if (!Array.isArray(paidBy) || paidBy.length === 0) {
      return null;
    }
    const bill = this.billById(billId);
    if (bill?.status !== "open") {
      return null;
    }
    const emissions: Emission[] = [];
    for (const identity of paidBy) {
      const target = this.resolveOptionalIdentity(identity, ctx);
      if (!target || target === bill.payer_handle) {
        continue;
      }
      if (ctx.actor !== target && ctx.actor !== bill.payer_handle) {
        continue;
      }
      emissions.push(...this.markSharePaid(billId, target, ctx.now).emissions);
    }
    return emissions.length > 0 ? { emissions } : null;
  }

  private observeCorrections(
    ctx: ChatContext,
    billId: number,
    fixedShares: FixedShares,
  ): ActionResult | null {
    if (!fixedShares || typeof fixedShares !== "object") {
      return null;
    }
    const bill = this.billById(billId);
    if (
      !bill ||
      (ctx.actor !== bill.payer_handle && !this.shareExists(billId, ctx.actor))
    ) {
      return null;
    }
    const emissions: Emission[] = [];
    for (const [identity, amount] of Object.entries(fixedShares)) {
      const target = this.resolveOptionalIdentity(identity, ctx);
      const cents = parseDollars(amount);
      if (!target || cents === null) {
        continue;
      }
      if (ctx.actor !== target && ctx.actor !== bill.payer_handle) {
        continue;
      }
      emissions.push(
        ...this.adjustShare(billId, target, cents, ctx.now, ctx).emissions,
      );
    }
    return emissions.length > 0 ? { emissions } : null;
  }

  private markSharePaid(
    billId: number,
    target: string,
    now: number,
  ): ActionResult {
    const bill = this.billById(billId);
    const share = this.db
      .query<ShareRow, [number, string]>(
        "SELECT * FROM bill_shares WHERE bill_id = ? AND handle = ?",
      )
      .get(billId, target);
    if (bill?.status !== "open" || !share || target === bill.payer_handle) {
      return resultError("That participant does not owe this bill.");
    }
    if (share.paid_at !== null) {
      return { emissions: [], data: { billId, handle: target, paid: true } };
    }
    this.db
      .query(
        "UPDATE bill_shares SET paid_at = ?, forgiven_at = NULL WHERE bill_id = ? AND handle = ?",
      )
      .run(now, billId, target);
    return {
      emissions: this.settleIfComplete(billId, now),
      data: { billId, handle: target, paid: true },
    };
  }

  private settleBill(ctx: ChatContext): ActionResult {
    const bill = this.latestOpenBill(ctx.chatId);
    if (!bill) {
      return resultError("There is no open bill.");
    }
    if (ctx.actor !== bill.payer_handle) {
      return resultError("Only the payer can settle this bill.");
    }
    this.db
      .query(
        "UPDATE bill_shares SET paid_at = COALESCE(paid_at, ?), forgiven_at = NULL WHERE bill_id = ? AND handle != ?",
      )
      .run(ctx.now, bill.id, bill.payer_handle);
    return {
      emissions: this.settleIfComplete(bill.id, ctx.now),
      data: { billId: bill.id, settled: true },
    };
  }

  private forgiveShare(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const bill = this.latestOpenBill(ctx.chatId);
    if (!bill) {
      return resultError("There is no open bill.");
    }
    if (ctx.actor !== bill.payer_handle) {
      return resultError("Only the payer can forgive a share.");
    }
    const target = this.resolveOptionalIdentity(
      args.handle ?? args.person ?? args.name,
      ctx,
    );
    if (!target || target === bill.payer_handle) {
      return resultError("I need a known debtor to forgive.");
    }
    const share = this.db
      .query<ShareRow, [number, string]>(
        "SELECT * FROM bill_shares WHERE bill_id = ? AND handle = ?",
      )
      .get(bill.id, target);
    if (!share) {
      return resultError("That participant is not in this split.");
    }
    this.db
      .query(
        "UPDATE bill_shares SET paid_at = ?, forgiven_at = ? WHERE bill_id = ? AND handle = ?",
      )
      .run(ctx.now, ctx.now, bill.id, target);
    return {
      emissions: this.settleIfComplete(bill.id, ctx.now),
      data: { billId: bill.id, handle: target, forgiven: true },
    };
  }

  private answerTip(
    bill: SplitBillRow,
    text: string,
    ctx: ChatContext,
  ): ActionResult | null {
    const lower = text.trim().toLowerCase();
    let tipCents: number | null = null;
    const option = lower.match(/^([1-4])(?:\D|$)/)?.[1];
    if (option === "1") {
      tipCents = Math.round((bill.total_cents * 18) / 100);
    } else if (option === "2") {
      tipCents = Math.round((bill.total_cents * 20) / 100);
    } else if (option === "4" || /\b(?:no|none|without)\s+tip\b/.test(lower)) {
      tipCents = 0;
    } else if (option === "3") {
      tipCents = parseDollars(text.replace(/^\s*3\D*/i, ""));
    } else {
      const percent = lower.match(/(\d+(?:\.\d+)?)\s*%/);
      if (percent) {
        const value = Number(percent[1]);
        if (Number.isFinite(value) && value >= 0 && value <= 100) {
          tipCents = Math.round((bill.total_cents * value) / 100);
        }
      } else {
        const amountMatch = lower.match(
          /(?:tip\s*(?:is|of)?|add)\s*\$?(\d+(?:\.\d{1,2})?)/,
        );
        if (amountMatch) {
          tipCents = parseDollars(amountMatch[1]);
        }
      }
    }
    if (tipCents === null) {
      return null;
    }
    const fixed = this.readFixed(bill);
    let shares: SplitResult;
    try {
      shares = splitBill(
        bill.total_cents + tipCents,
        this.readPeople(bill),
        fixed,
        bill.payer_handle,
      );
    } catch (error) {
      return resultError(
        error instanceof Error ? error.message : "Invalid tip split.",
      );
    }
    const finalize = this.db.transaction(() => {
      const changed = this.db
        .query(
          "UPDATE bills SET tip_cents = ? WHERE id = ? AND status = 'open' AND tip_state = 'pending'",
        )
        .run(tipCents, bill.id).changes;
      if (changed !== 1) {
        return false;
      }
      const updated = this.billById(bill.id);
      if (!updated) {
        return false;
      }
      this.materializeShares(updated, shares);
      return true;
    });
    if (!finalize()) {
      return null;
    }
    return this.splitResult(ctx, bill.id);
  }

  private isTipAnswer(text: string): boolean {
    return /^(?:[1-4](?:\D|$)|(?:no|none|without)\s+tip|(?:tip\s*(?:is|of)?|add)\s*\$?\d|\d+(?:\.\d+)?\s*%)/i.test(
      text.trim(),
    );
  }

  private latestPendingTip(chatId: string): SplitBillRow | null {
    return (
      this.db
        .query<SplitBillRow, [string]>(
          "SELECT * FROM bills WHERE chat_id = ? AND status = 'open' AND tip_state = 'pending' ORDER BY id DESC LIMIT 1",
        )
        .get(chatId) ?? null
    );
  }

  private latestOpenBill(chatId: string): SplitBillRow | null {
    return (
      this.db
        .query<SplitBillRow, [string]>(
          "SELECT * FROM bills WHERE chat_id = ? AND status = 'open' AND tip_state = 'resolved' ORDER BY id DESC LIMIT 1",
        )
        .get(chatId) ?? null
    );
  }

  private latestOpenBillFor(
    chatId: string,
    handle: string,
  ): SplitBillRow | null {
    return (
      this.db
        .query<SplitBillRow, [string, string]>(
          `SELECT b.* FROM bills b JOIN bill_shares s ON s.bill_id = b.id
          WHERE b.chat_id = ? AND b.status = 'open' AND b.tip_state = 'resolved'
            AND s.handle = ? AND s.handle != b.payer_handle AND s.paid_at IS NULL
          ORDER BY b.id DESC LIMIT 1`,
        )
        .get(chatId, handle) ?? null
    );
  }

  private latestOpenOrSettledBill(chatId: string): SplitBillRow | null {
    return (
      this.db
        .query<SplitBillRow, [string]>(
          "SELECT * FROM bills WHERE chat_id = ? AND tip_state = 'resolved' AND status IN ('open','settled') ORDER BY id DESC LIMIT 1",
        )
        .get(chatId) ?? null
    );
  }

  private latestBill(chatId: string): SplitBillRow | null {
    return (
      this.db
        .query<SplitBillRow, [string]>(
          "SELECT * FROM bills WHERE chat_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(chatId) ?? null
    );
  }

  private billById(id: number): SplitBillRow | null {
    return (
      this.db
        .query<SplitBillRow, [number]>("SELECT * FROM bills WHERE id = ?")
        .get(id) ?? null
    );
  }

  private sharesFor(billId: number): ShareRow[] {
    return this.db
      .query<ShareRow, [number]>(
        "SELECT * FROM bill_shares WHERE bill_id = ? ORDER BY rowid",
      )
      .all(billId);
  }

  private shareExists(billId: number, handle: string): boolean {
    return Boolean(
      this.db
        .query<{ handle: string }, [number, string]>(
          "SELECT handle FROM bill_shares WHERE bill_id = ? AND handle = ?",
        )
        .get(billId, handle),
    );
  }

  private settleIfComplete(
    billId: number,
    _now: number,
    invalidateSplit = true,
  ): Emission[] {
    const bill = this.billById(billId);
    if (bill?.status !== "open" || bill.tip_state !== "resolved") {
      return [];
    }
    const outstanding =
      this.db
        .query<{ count: number }, [number, string]>(
          `SELECT COUNT(*) AS count FROM bill_shares
          WHERE bill_id = ? AND handle != ? AND paid_at IS NULL`,
        )
        .get(bill.id, bill.payer_handle)?.count ?? 0;
    if (outstanding !== 0) {
      return [];
    }
    if (bill.settled_notice_sent) {
      this.db
        .query(
          "UPDATE bills SET status = 'settled', split_revision = split_revision + ? WHERE id = ?",
        )
        .run(Number(invalidateSplit), bill.id);
      return [];
    }
    this.db
      .query(
        "UPDATE bills SET status = 'settled', settled_notice_sent = 1, split_revision = split_revision + ? WHERE id = ?",
      )
      .run(Number(invalidateSplit), bill.id);
    return [
      {
        chatId: bill.chat_id,
        key: `bill:${bill.id}:settled`,
        text: `✅ All settled — ${bill.label} bill is paid.`,
      },
    ];
  }

  private combine(
    first: ActionResult | null,
    second: ActionResult,
  ): ActionResult {
    return {
      emissions: [...(first?.emissions ?? []), ...second.emissions],
      data: second.data ?? first?.data,
    };
  }

  private readPeople(bill: SplitBillRow): string[] {
    try {
      const parsed: unknown = JSON.parse(bill.people_json);
      return Array.isArray(parsed) &&
        parsed.every((value) => typeof value === "string")
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  private readFixed(bill: SplitBillRow): FixedShares {
    try {
      const parsed: unknown = JSON.parse(bill.fixed_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const fixed: FixedShares = {};
      for (const [handle, value] of Object.entries(parsed)) {
        if (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0
        ) {
          fixed[handle] = value;
        }
      }
      return fixed;
    } catch {
      return {};
    }
  }

  private shareData(shares: ShareRow[]): unknown[] {
    return shares.map((share) => ({
      handle: share.handle,
      amountCents: share.amount_cents,
      fixed: Boolean(share.fixed),
      paidAt: share.paid_at,
      forgivenAt: share.forgiven_at,
    }));
  }

  private resolveOptionalIdentity(
    value: unknown,
    ctx: ChatContext,
  ): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const resolved = participantByIdentity(value, ctx.participants);
    return "handle" in resolved ? resolved.handle : null;
  }

  private resolveActor(ctx: ChatContext, handle: string): string | null {
    if (handle === ctx.actor && this.hasParticipant(ctx.participants, handle)) {
      return handle;
    }
    return this.hasParticipant(ctx.participants, handle) ? handle : null;
  }

  private hasParticipant(participants: Participant[], handle: string): boolean {
    return participants.some((participant) => participant.handle === handle);
  }

  private displayForChat(handle: string, participants: Participant[]): string {
    return displayName(handle, participants);
  }

  private cleanLabel(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const label = value.trim().replace(/\s+/g, " ");
    return label.length > 0 && label.length <= 80 ? label : null;
  }
}

export const billingTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "split_bill",
      description:
        "Split a shared expense among known chat participants using exact integer cents.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: {
            type: "number",
            description: "Total dollars, with at most two decimal places.",
          },
          payer: {
            type: "string",
            description: "Known payer handle or unambiguous participant name.",
          },
          people: {
            type: "array",
            items: { type: "string" },
            description: "Known participant identities.",
          },
          split_hint: {
            type: "string",
            description:
              "Identity/count hint such as 'Alex and Jess' or '4 ways'.",
          },
          label: { type: "string", description: "Known short expense label." },
          includes_tip: { type: "string", enum: ["yes", "no", "unknown"] },
          fixed_shares: {
            type: "object",
            additionalProperties: { type: "number" },
          },
        },
        required: ["total"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_paid",
      description:
        "Mark the caller's debt paid, or let the payer report a known debtor's payment.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          handle: {
            type: "string",
            description: "Known debtor identity; omit for the caller.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "adjust_share",
      description:
        "Set one known participant's fixed share and re-split the remaining cents.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          handle: {
            type: "string",
            description: "Known participant identity.",
          },
          amount: { type: "number", description: "Corrected dollar amount." },
          amount_cents: { type: "integer", minimum: 0 },
        },
        required: ["handle", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_balances",
      description: "Show the current bill balances and paid debtors.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  },
];
