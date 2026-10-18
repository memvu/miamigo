import type { Database, SQLQueryBindings } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import type {
  ActionResult,
  ChatContext,
  Classification,
  DeliveryTag,
  Emission,
  IncomingMessage,
  Participant,
  PlanSnapshot,
  Stage,
  ToolDefinition,
} from "./contracts";
import {
  formatAbsolute,
  formatDateOnly,
  formatPollClose,
  formatReminderTime,
  parseDateTime,
} from "./time";
import { type PollTally, parseVote, tallyVotes } from "./votes";

const PROPOSAL_WINDOW_MS = 10 * 60 * 1000;
const TALLY_THROTTLE_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface PlanRow {
  id: number;
  chat_id: string;
  title: string;
  what: string;
  location: string | null;
  starts_at: number | null;
  stage: Stage;
  interested_json: string;
  going_json: string;
  time_options_json: string;
  place_options_json: string;
  extracted_json: string;
  stage_changed_at: number;
  proposed_at: number | null;
  locked_at: number | null;
  created_at: number;
  spoke_in_stage: number;
}

interface AvailabilityRow {
  handle: string;
  option: string;
  answer: "yes" | "no" | "maybe";
}

interface PollRow {
  id: number;
  plan_id: number;
  chat_id: string;
  question: string;
  options_json: string;
  closes_at: number;
  status: "open" | "closed";
  created_at: number;
  closed_at: number | null;
  last_tally_at: number | null;
}

interface VoteRow {
  handle: string;
  choices_json: string;
}

interface ReminderRow {
  id: number;
  chat_id: string;
  plan_id: number;
  fire_at: number;
  text: string;
  kind: "day_before" | "hour_before" | "custom";
  sent: number;
}

interface DeliveryRow {
  key: string;
  chat_id: string;
  kind: DeliveryTag["kind"];
  resource_id: number;
  text: string;
  sent: number;
  guid: string | null;
  created_at: number;
}

interface ParticipantLike {
  handle: string;
  name: string;
}

const StartPlanSchema = z.object({
  title: z.string().trim().min(1).optional(),
  what: z.string().trim().min(1).optional(),
  activity: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1).nullable().optional(),
  starts_at: z
    .union([z.number().finite(), z.string().trim().min(1)])
    .nullable()
    .optional(),
  going: z.array(z.string().trim().min(1)).optional(),
  time_options: z.array(z.string().trim().min(1)).optional(),
  place_options: z.array(z.string().trim().min(1)).optional(),
  poll_question: z.string().trim().min(1).optional(),
  poll_closes_at: z
    .union([z.number().finite(), z.string().trim().min(1)])
    .optional(),
});

const PollSchema = z.object({
  plan_id: z.number().int().positive().optional(),
  title: z.string().trim().min(1).optional(),
  what: z.string().trim().min(1).optional(),
  activity: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1).nullable().optional(),
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).min(2).max(12),
  closes_at: z.union([z.number().finite(), z.string().trim().min(1)]),
});

const FinalizeSchema = z
  .object({
    plan_id: z.number().int().positive().optional(),
    location: z.string().trim().min(1).optional(),
    starts_at: z
      .union([z.number().finite(), z.string().trim().min(1)])
      .optional(),
    going: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const ReminderSchema = z.object({
  plan_id: z.number().int().positive().optional(),
  fire_at: z.union([z.number().finite(), z.string().trim().min(1)]),
});

const ClarifySchema = z.object({
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).min(2).max(4).optional(),
});

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizedMessage(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "");
}

function isConfirmation(text: string): boolean {
  return /^(?:yes|y|bet|ok|okay|confirm|confirmed|lock|do it|go ahead|👍|✅)$/iu.test(
    normalizedMessage(text),
  );
}

function isObjection(text: string): boolean {
  const normalized = normalizedMessage(text);
  return /\b(?:no|wait|hold|objection|can't|cannot|move|change|reschedul|different|not work|doesn't work)\b/iu.test(
    normalized,
  );
}

export class Planning {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        what TEXT NOT NULL,
        location TEXT,
        starts_at INTEGER,
        stage TEXT NOT NULL,
        interested_json TEXT NOT NULL DEFAULT '[]',
        going_json TEXT NOT NULL DEFAULT '[]',
        time_options_json TEXT NOT NULL DEFAULT '[]',
        place_options_json TEXT NOT NULL DEFAULT '[]',
        extracted_json TEXT NOT NULL DEFAULT '{}',
        stage_changed_at INTEGER NOT NULL,
        proposed_at INTEGER,
        locked_at INTEGER,
        created_at INTEGER NOT NULL,
        spoke_in_stage INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS plans_chat_idx ON plans(chat_id, id DESC);
      CREATE TABLE IF NOT EXISTS availability (
        plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        handle TEXT NOT NULL,
        option TEXT NOT NULL,
        answer TEXT NOT NULL CHECK(answer IN ('yes', 'no', 'maybe')),
        source TEXT NOT NULL CHECK(source IN ('chat', 'poll', 'tapback')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(plan_id, handle, option)
      );
      CREATE TABLE IF NOT EXISTS polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        closes_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        last_tally_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS polls_chat_idx ON polls(chat_id, status, closes_at);
      CREATE TABLE IF NOT EXISTS votes (
        poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        handle TEXT NOT NULL,
        choices_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'explicit' CHECK(source IN ('explicit', 'availability')),
        PRIMARY KEY(poll_id, handle)
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        fire_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('day_before', 'hour_before', 'custom')),
        sent INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(chat_id, sent, fire_at);
      CREATE TABLE IF NOT EXISTS planning_delivery_events (
        key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        resource_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0,
        guid TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS planning_delivery_tag_idx
        ON planning_delivery_events(kind, resource_id, sent, created_at);
      CREATE TABLE IF NOT EXISTS planning_current_proposals (
        plan_id INTEGER PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS planning_current_locks (
        plan_id INTEGER PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const voteColumns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(votes)")
      .all();
    if (!voteColumns.some((column) => column.name === "source")) {
      this.db.exec(
        "ALTER TABLE votes ADD COLUMN source TEXT NOT NULL DEFAULT 'explicit' CHECK(source IN ('explicit', 'availability'))",
      );
    }
  }

  snapshot(chatId: string): PlanSnapshot | null {
    const row = this.activePlan(chatId);
    return row ? this.snapshotForRow(row) : null;
  }

  hasActive(chatId: string): boolean {
    return this.activePlan(chatId) !== null;
  }

  merge(ctx: ChatContext, decision: Classification): void {
    if (!decision.is_planning) {
      return;
    }
    let plan = this.activePlan(ctx.chatId);
    const extraction = decision.extracted;
    const interested = this.resolveMany(
      ctx.participants,
      extraction.interested,
    );
    const meaningful =
      interested.length > 0 ||
      stringArray(extraction.time_options).length > 0 ||
      stringArray(extraction.place_options).length > 0 ||
      Boolean(
        extraction.title ||
          extraction.activity ||
          extraction.starts_at ||
          extraction.location,
      );
    if (!plan && !meaningful) {
      return;
    }
    if (!plan) {
      const title =
        this.cleanText(extraction.title) ??
        this.cleanText(extraction.activity) ??
        "Plan";
      const what = this.cleanText(extraction.activity) ?? title;
      const inserted = this.db
        .query(
          `INSERT INTO plans
            (chat_id, title, what, stage, interested_json, going_json,
             time_options_json, place_options_json, extracted_json,
             stage_changed_at, created_at)
           VALUES (?, ?, ?, 'idea', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.chatId,
          title,
          what,
          JSON.stringify(interested),
          JSON.stringify(interested),
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify(extraction),
          ctx.now,
          ctx.now,
        );
      plan = this.planById(Number(inserted.lastInsertRowid));
    }
    if (!plan) {
      return;
    }
    if (plan.stage === "locked" && !extraction.objection) {
      return;
    }

    const currentInterested = parseJsonArray(plan.interested_json);
    const mergedInterested = uniqueStrings([
      ...currentInterested,
      ...interested,
    ]);
    const currentGoing = parseJsonArray(plan.going_json);
    const mergedGoing = uniqueStrings([...currentGoing, ...mergedInterested]);
    const timeOptions = this.normalizeTimeOptions(
      [
        ...parseJsonArray(plan.time_options_json),
        ...stringArray(extraction.time_options),
      ],
      ctx,
    );
    const placeOptions = uniqueStrings([
      ...parseJsonArray(plan.place_options_json),
      ...stringArray(extraction.place_options),
    ]);
    const parsedStartsAt = extraction.starts_at
      ? parseDateTime(extraction.starts_at, ctx.now, ctx.tz)
      : null;
    const startsAt = parsedStartsAt ?? plan.starts_at;
    const location = this.cleanText(extraction.location) ?? plan.location;
    const title = this.cleanText(extraction.title) ?? plan.title;
    const what = this.cleanText(extraction.activity) ?? plan.what;

    if (extraction.objection) {
      this.reopenPlan(plan.id, ctx.now);
      plan = this.planById(plan.id);
      if (!plan) {
        return;
      }
    }

    let availabilityChanged = false;
    for (const [rawHandle, availability] of Object.entries(
      extraction.availability ?? {},
    )) {
      const handle = this.resolveOne(ctx.participants, rawHandle);
      if (!handle) {
        continue;
      }
      availabilityChanged =
        this.mergeAvailability(plan.id, handle, availability, ctx) ||
        availabilityChanged;
    }

    const stateChanged =
      plan.title !== title ||
      plan.what !== what ||
      plan.location !== location ||
      plan.starts_at !== startsAt ||
      JSON.stringify(parseJsonArray(plan.interested_json)) !==
        JSON.stringify(mergedInterested) ||
      JSON.stringify(parseJsonArray(plan.going_json)) !==
        JSON.stringify(mergedGoing) ||
      JSON.stringify(parseJsonArray(plan.time_options_json)) !==
        JSON.stringify(timeOptions) ||
      JSON.stringify(parseJsonArray(plan.place_options_json)) !==
        JSON.stringify(placeOptions) ||
      availabilityChanged;
    const proposedStage = extraction.objection
      ? timeOptions.length > 0
        ? "choosing_time"
        : placeOptions.length > 0
          ? "choosing_place"
          : "gathering"
      : this.stageAfterMerge(
          plan,
          mergedInterested,
          mergedGoing,
          timeOptions,
          placeOptions,
          startsAt,
          location,
          ctx,
          stateChanged,
        );
    if (plan.stage === "ready_to_lock" && stateChanged) {
      this.invalidateProposal(plan.id);
    }
    const changed = proposedStage !== plan.stage;
    this.db
      .query(
        `UPDATE plans SET title = ?, what = ?, location = ?, starts_at = ?,
          stage = ?, interested_json = ?, going_json = ?, time_options_json = ?,
          place_options_json = ?, extracted_json = ?, stage_changed_at = CASE
            WHEN ? THEN ? ELSE stage_changed_at END
         WHERE id = ?`,
      )
      .run(
        title,
        what,
        location,
        startsAt,
        proposedStage,
        JSON.stringify(mergedInterested),
        JSON.stringify(mergedGoing),
        JSON.stringify(timeOptions),
        JSON.stringify(placeOptions),
        JSON.stringify(extraction),
        changed ? 1 : 0,
        ctx.now,
        plan.id,
      );
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    this.authorize(ctx);
    switch (name) {
      case "start_plan":
        return this.startPlan(args, ctx);
      case "create_poll":
        return this.createPoll(args, ctx);
      case "get_poll_status":
        return this.pollStatus(args, ctx);
      case "finalize_plan":
        return this.finalizePlan(args, ctx);
      case "nudge":
        return this.nudge(args, ctx);
      case "schedule_reminder":
        return this.scheduleReminder(args, ctx);
      case "ask_clarify":
        return this.askClarify(args, ctx);
      case "cancel_plan":
        return this.cancelPlan(args, ctx);
      case "export_invite":
      case "get_calendar":
        return this.calendarInvite(ctx);
      default:
        throw new Error(`Unsupported planning tool: ${name}`);
    }
  }

  handleMessage(
    ctx: ChatContext,
    message: IncomingMessage,
  ): ActionResult | null {
    if (
      message.isFromMe ||
      message.reaction ||
      !message.isGroup ||
      message.chatId !== ctx.chatId
    ) {
      return null;
    }
    const actorHandle = this.resolveOne(ctx.participants, message.handle);
    if (!actorHandle) {
      return null;
    }
    const body = message.text.trim();
    if (!body) {
      return null;
    }
    if (body.startsWith("/")) {
      return this.handleCommand(ctx, message);
    }

    const plan = this.activePlan(ctx.chatId);
    const poll = plan ? this.openPoll(plan.id) : null;
    if (poll) {
      const parsed = parseVote(body, this.pollOptions(poll).length);
      if (parsed) {
        return this.recordVote(ctx, poll, actorHandle, parsed.choices);
      }
    } else if (plan) {
      const closedPoll = this.latestPoll(plan.id);
      if (closedPoll && parseVote(body, this.pollOptions(closedPoll).length)) {
        return { emissions: [], data: { accepted: false, reason: "closed" } };
      }
    }

    if (!plan) {
      return null;
    }
    if (plan.stage === "ready_to_lock") {
      if (isObjection(body)) {
        this.reopenPlan(plan.id, ctx.now);
        return { emissions: [] };
      }
      if (isConfirmation(body) && this.currentProposalWasDelivered(plan)) {
        return this.confirmPlan(plan.id, ctx);
      }
    }
    if (plan.stage === "locked" && isObjection(body)) {
      this.reopenPlan(plan.id, ctx.now);
      return { emissions: [] };
    }
    return null;
  }

  handleReaction(
    ctx: ChatContext,
    message: IncomingMessage,
  ): ActionResult | null {
    if (
      message.isFromMe ||
      !message.reaction ||
      message.reaction.removed ||
      !message.isGroup ||
      message.chatId !== ctx.chatId
    ) {
      return null;
    }
    if (!this.resolveOne(ctx.participants, message.handle)) {
      return null;
    }
    const proposal = this.one<DeliveryRow>(
      `SELECT event.key, event.chat_id, event.kind, event.resource_id, event.text,
          event.sent, event.guid, event.created_at
       FROM planning_current_proposals AS current
       JOIN planning_delivery_events AS event ON event.key = current.key
       WHERE event.chat_id = ? AND event.kind = 'lock' AND event.guid = ?
         AND event.sent = 1`,
      [ctx.chatId, message.reaction.targetId],
    );
    if (!proposal) {
      return null;
    }
    const plan = this.planById(proposal.resource_id);
    if (
      !plan ||
      plan.chat_id !== ctx.chatId ||
      !this.isCurrentDeliveredProposal(plan, proposal)
    ) {
      return null;
    }
    const positive = ["👍", "✅", "‼️", "‼"].includes(message.reaction.emoji);
    const negative = ["👎", "❌"].includes(message.reaction.emoji);
    if (positive) {
      return this.confirmPlan(plan.id, ctx);
    }
    if (negative) {
      this.reopenPlan(plan.id, ctx.now);
      return { emissions: [] };
    }
    return null;
  }

  tick(ctx: ChatContext): ActionResult {
    const emissions: Emission[] = [];
    const duePolls = this.all<PollRow>(
      `SELECT id, plan_id, chat_id, question, options_json, closes_at, status,
          created_at, closed_at, last_tally_at
       FROM polls WHERE chat_id = ? AND status = 'open' AND closes_at <= ?
       ORDER BY id`,
      [ctx.chatId, ctx.now],
    );
    for (const poll of duePolls) {
      this.db
        .query("UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ?")
        .run(ctx.now, poll.id);
      const plan = this.planById(poll.plan_id);
      if (!plan) {
        continue;
      }
      const emission = this.tallyEmission(ctx, poll, "closed");
      if (emission) {
        emissions.push(emission);
      }
    }

    const dueProposals = this.all<PlanRow>(
      `SELECT id, chat_id, title, what, location, starts_at, stage,
          interested_json, going_json, time_options_json, place_options_json,
          extracted_json, stage_changed_at, proposed_at, locked_at, created_at,
          spoke_in_stage
       FROM plans
       WHERE chat_id = ? AND stage = 'ready_to_lock' AND proposed_at IS NOT NULL
         AND proposed_at <= ?
       ORDER BY id`,
      [ctx.chatId, ctx.now - PROPOSAL_WINDOW_MS],
    );
    for (const plan of dueProposals) {
      const lock = this.lockPlan(plan, ctx);
      if (lock) {
        emissions.push(lock);
      }
    }

    const dueReminders = this.all<ReminderRow>(
      `SELECT id, chat_id, plan_id, fire_at, text, kind, sent
       FROM reminders WHERE chat_id = ? AND sent = 0 AND fire_at <= ?
       ORDER BY id`,
      [ctx.chatId, ctx.now],
    );
    for (const reminder of dueReminders) {
      const plan = this.planById(reminder.plan_id);
      if (
        !plan ||
        plan.stage === "cancelled" ||
        plan.stage === "done" ||
        (reminder.kind !== "custom" && plan.stage !== "locked")
      ) {
        continue;
      }
      const emission = this.delivery(
        ctx,
        reminder.text,
        `plan-reminder:${reminder.id}`,
        { kind: "plan_reminder", id: reminder.id },
      );
      if (emission) {
        emissions.push(emission);
      }
    }
    return { emissions };
  }

  sent(
    tag: DeliveryTag,
    guid: string | undefined,
    now: number,
    eventKey?: string,
  ): void {
    const key = eventKey ?? tag.key;
    if (!key) {
      return;
    }
    const event = this.one<DeliveryRow>(
      `SELECT key, chat_id, kind, resource_id, text, sent, guid, created_at
       FROM planning_delivery_events
       WHERE key = ? AND kind = ? AND resource_id = ?`,
      [key, tag.kind, tag.id],
    );
    if (!event) {
      return;
    }
    if (event.sent === 1) {
      if (guid && !event.guid) {
        this.db
          .query(
            "UPDATE planning_delivery_events SET guid = ? WHERE key = ? AND guid IS NULL",
          )
          .run(guid, event.key);
      }
      return;
    }
    this.db
      .query(
        "UPDATE planning_delivery_events SET sent = 1, guid = ?, created_at = ? WHERE key = ? AND sent = 0",
      )
      .run(guid ?? null, now, event.key);
    if (tag.kind === "plan_reminder") {
      this.db
        .query("UPDATE reminders SET sent = 1 WHERE id = ? AND sent = 0")
        .run(tag.id);
      return;
    }
    if (
      tag.kind === "lock" &&
      event.key.includes(":proposal:") &&
      this.isCurrentProposalKey(tag.id, event.key)
    ) {
      const plan = this.planById(tag.id);
      if (plan?.stage === "ready_to_lock" && this.hasConcreteProposal(plan)) {
        this.db
          .query(
            "UPDATE plans SET proposed_at = ? WHERE id = ? AND stage = 'ready_to_lock'",
          )
          .run(now, tag.id);
      }
    }
  }

  isDeliverable(tag: DeliveryTag, now: number, eventKey?: string): boolean {
    if (!Number.isFinite(now)) {
      return false;
    }
    const key = eventKey ?? tag.key;
    if (!key) {
      return false;
    }
    const event = this.one<DeliveryRow>(
      `SELECT key, chat_id, kind, resource_id, text, sent, guid, created_at
       FROM planning_delivery_events
       WHERE key = ? AND kind = ? AND resource_id = ? AND sent = 0`,
      [key, tag.kind, tag.id],
    );
    if (!event) {
      return false;
    }
    if (tag.kind === "plan_reminder") {
      const reminder = this.one<ReminderRow>(
        `SELECT id, chat_id, plan_id, fire_at, text, kind, sent
         FROM reminders WHERE id = ?`,
        [tag.id],
      );
      const plan = reminder ? this.planById(reminder.plan_id) : null;
      return Boolean(
        reminder &&
          reminder.sent === 0 &&
          reminder.fire_at <= now &&
          plan &&
          plan.stage !== "cancelled" &&
          plan.stage !== "done" &&
          (reminder.kind === "custom" || plan.stage === "locked"),
      );
    }
    if (tag.kind === "poll") {
      if (event.key.startsWith("status:")) {
        const plan = this.planById(tag.id);
        return Boolean(
          plan &&
            plan.stage !== "cancelled" &&
            plan.stage !== "done" &&
            this.statusKey(plan) === event.key,
        );
      }
      const poll = this.pollById(tag.id);
      const plan = poll ? this.planById(poll.plan_id) : null;
      if (
        !poll ||
        !plan ||
        plan.stage === "cancelled" ||
        plan.stage === "done" ||
        (poll.status === "open" && poll.closes_at <= now)
      ) {
        return false;
      }
      if (event.key.endsWith(":open") || event.key.includes(":nudge:")) {
        return poll.status === "open";
      }
      if (!event.key.includes(":tally:")) {
        return false;
      }
      const phase = event.key.split(":tally:")[1]?.split(":")[0];
      if (phase === "closed") {
        return poll.status === "closed";
      }
      if (phase === "vote") {
        return poll.status === "open";
      }
      if (phase === "status") {
        return (
          poll.status === "open" ||
          (poll.closed_at !== null && event.created_at >= poll.closed_at)
        );
      }
      return false;
    }
    if (tag.kind === "lock") {
      if (tag.id === 0) {
        return true;
      }
      const plan = this.planById(tag.id);
      if (!plan || plan.stage === "cancelled" || plan.stage === "done") {
        return false;
      }
      if (event.key.includes(":proposal:")) {
        return (
          plan.stage === "ready_to_lock" &&
          this.isCurrentProposalKey(tag.id, event.key) &&
          this.hasConcreteProposal(plan)
        );
      }
      if (event.key.includes(":lock:")) {
        const current = this.one<{ key: string }>(
          "SELECT key FROM planning_current_locks WHERE plan_id = ?",
          [tag.id],
        );
        return plan.stage === "locked" && current?.key === event.key;
      }
      if (event.key.includes("clarify:") || event.key.startsWith("clarify:")) {
        return true;
      }
      if (event.key.includes(":invite:")) {
        return true;
      }
      return event.key === `plan:${tag.id}:kickoff`;
    }
    return true;
  }

  forget(chatId: string): void {
    this.db
      .query("DELETE FROM planning_delivery_events WHERE chat_id = ?")
      .run(chatId);
    this.db.query("DELETE FROM reminders WHERE chat_id = ?").run(chatId);
    this.db
      .query(
        "DELETE FROM votes WHERE poll_id IN (SELECT id FROM polls WHERE chat_id = ?)",
      )
      .run(chatId);
    this.db
      .query(
        "DELETE FROM availability WHERE plan_id IN (SELECT id FROM plans WHERE chat_id = ?)",
      )
      .run(chatId);
    this.db.query("DELETE FROM polls WHERE chat_id = ?").run(chatId);
    this.db.query("DELETE FROM plans WHERE chat_id = ?").run(chatId);
  }

  private startPlan(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const parsed = StartPlanSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        "start_plan requires a title or activity and valid optional fields.",
      );
    }
    const title = parsed.data.title ?? parsed.data.activity ?? parsed.data.what;
    const what = parsed.data.what ?? parsed.data.activity ?? title;
    if (!title || !what) {
      throw new Error("start_plan requires a concrete title or activity.");
    }
    const location = parsed.data.location ?? null;
    const startsAt =
      parsed.data.starts_at === undefined || parsed.data.starts_at === null
        ? null
        : parseDateTime(parsed.data.starts_at, ctx.now, ctx.tz);
    if (
      parsed.data.starts_at !== undefined &&
      parsed.data.starts_at !== null &&
      startsAt === null
    ) {
      throw new Error(
        "start_plan could not resolve starts_at in the chat timezone.",
      );
    }
    const going = parsed.data.going
      ? this.resolveRequired(ctx.participants, parsed.data.going)
      : [];
    const timeOptions = this.normalizeTimeOptions(
      parsed.data.time_options ?? [],
      ctx,
    );
    const placeOptions = uniqueStrings(parsed.data.place_options ?? []);
    const stage: Stage =
      timeOptions.length > 0
        ? "choosing_time"
        : placeOptions.length > 0
          ? "choosing_place"
          : "gathering";
    const inserted = this.db
      .query(
        `INSERT INTO plans
          (chat_id, title, what, location, starts_at, stage, interested_json,
           going_json, time_options_json, place_options_json, extracted_json,
           stage_changed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      )
      .run(
        ctx.chatId,
        title,
        what,
        location,
        startsAt,
        stage,
        JSON.stringify(going),
        JSON.stringify(going),
        JSON.stringify(timeOptions),
        JSON.stringify(placeOptions),
        ctx.now,
        ctx.now,
      );
    const plan = this.planById(Number(inserted.lastInsertRowid));
    if (!plan) {
      throw new Error("The plan could not be persisted.");
    }
    const emissions: Emission[] = [];
    const kickoff = this.delivery(
      ctx,
      this.renderKickoff(plan, ctx.tz),
      `plan:${plan.id}:kickoff`,
      {
        kind: "lock",
        id: plan.id,
      },
    );
    if (kickoff) {
      emissions.push(kickoff);
    }
    const pollOptions =
      timeOptions.length > 1
        ? timeOptions
        : placeOptions.length > 1
          ? placeOptions
          : parsed.data.poll_question !== undefined
            ? ["I'm in", "Can't make it"]
            : [];
    if (pollOptions.length > 1 && parsed.data.poll_closes_at !== undefined) {
      const closesAt = parseDateTime(
        parsed.data.poll_closes_at,
        ctx.now,
        ctx.tz,
      );
      if (closesAt && closesAt > ctx.now) {
        const question =
          parsed.data.poll_question ??
          (timeOptions.length > 1
            ? "Which day works?"
            : placeOptions.length > 1
              ? "Which place works?"
              : `Who's in for ${plan.title}?`);
        const poll = this.insertPoll(plan, question, pollOptions, closesAt, ctx);
        const pollEmission = this.delivery(
          ctx,
          this.renderPoll(poll, pollOptions, ctx.tz, ctx.participants),
          `poll:${poll.id}:open`,
          { kind: "poll", id: poll.id },
        );
        if (pollEmission) {
          emissions.push(pollEmission);
        }
      }
    }
    return { emissions, data: this.snapshotForRow(plan) };
  }

  private createPoll(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const parsed = PollSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        "create_poll requires a question, two or more options, and closes_at.",
      );
    }
    let plan = this.planForArgs(parsed.data.plan_id, ctx.chatId);
    const options = uniqueStrings(parsed.data.options);
    if (options.length < 2) {
      throw new Error("create_poll options must be distinct and nonempty.");
    }
    const closesAt = parseDateTime(parsed.data.closes_at, ctx.now, ctx.tz);
    if (closesAt === null || closesAt <= ctx.now) {
      throw new Error(
        "create_poll closes_at must be a future date in the chat timezone.",
      );
    }
    const emissions: Emission[] = [];
    if (!plan) {
      const title =
        parsed.data.title ?? parsed.data.activity ?? parsed.data.what;
      const what = parsed.data.what ?? parsed.data.activity ?? title;
      if (!title || !what) {
        throw new Error(
          "create_poll needs an active plan or a concrete title/activity.",
        );
      }
      const inserted = this.db
        .query(
          `INSERT INTO plans
            (chat_id, title, what, location, stage, interested_json, going_json,
             time_options_json, place_options_json, extracted_json, stage_changed_at, created_at)
           VALUES (?, ?, ?, ?, 'idea', '[]', '[]', '[]', '[]', '{}', ?, ?)`,
        )
        .run(
          ctx.chatId,
          title,
          what,
          parsed.data.location ?? null,
          ctx.now,
          ctx.now,
        );
      plan = this.planById(Number(inserted.lastInsertRowid));
    }
    if (
      !plan ||
      plan.chat_id !== ctx.chatId ||
      plan.stage === "cancelled" ||
      plan.stage === "done"
    ) {
      throw new Error("create_poll requires an active plan in this chat.");
    }
    if (plan.stage === "idea") {
      const kickoff = this.delivery(
        ctx,
        this.renderKickoff(plan, ctx.tz),
        `plan:${plan.id}:kickoff`,
        {
          kind: "lock",
          id: plan.id,
        },
      );
      if (kickoff) {
        emissions.push(kickoff);
      }
      const nextStage: Stage = /(?:day|time|when)/iu.test(parsed.data.question)
        ? "choosing_time"
        : "choosing_place";
      this.db
        .query("UPDATE plans SET stage = ?, stage_changed_at = ? WHERE id = ?")
        .run(nextStage, ctx.now, plan.id);
    }
    const poll = this.insertPoll(
      plan,
      parsed.data.question,
      options,
      closesAt,
      ctx,
    );
    const pollEmission = this.delivery(
      ctx,
      this.renderPoll(poll, options, ctx.tz, ctx.participants),
      `poll:${poll.id}:open`,
      { kind: "poll", id: poll.id },
    );
    if (pollEmission) {
      emissions.push(pollEmission);
    }
    return { emissions, data: poll };
  }

  private insertPoll(
    plan: PlanRow,
    question: string,
    options: readonly string[],
    closesAt: number,
    ctx: ChatContext,
  ): PollRow {
    const inserted = this.db
      .query(
        `INSERT INTO polls
          (plan_id, chat_id, question, options_json, closes_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        plan.id,
        ctx.chatId,
        question,
        JSON.stringify(options),
        closesAt,
        ctx.now,
      );
    const poll = this.pollById(Number(inserted.lastInsertRowid));
    if (!poll) {
      throw new Error("The poll could not be persisted.");
    }
    const handles = this.all<{ handle: string }>(
      "SELECT DISTINCT handle FROM availability WHERE plan_id = ?",
      [plan.id],
    );
    for (const { handle } of handles) {
      this.syncAvailabilityVotes(plan.id, handle, ctx);
    }
    return poll;
  }

  private pollStatus(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const id = this.optionalInteger(args.poll_id ?? args.id);
    const plan = this.activePlan(ctx.chatId);
    const poll =
      id === null ? (plan ? this.openPoll(plan.id) : null) : this.pollById(id);
    if (!poll) {
      if (!plan) {
        return {
          emissions: [
            {
              chatId: ctx.chatId,
              text: "No active plan yet. Use /plan to start one.",
              key: `status:none:${ctx.message?.id ?? ctx.now}`,
            },
          ],
        };
      }
      const snapshot = this.snapshotForRow(plan);
      const emission = this.delivery(
        ctx,
        this.renderStatus(plan, ctx.tz, snapshot),
        this.statusKey(plan),
        { kind: "poll", id: plan.id },
      );
      return {
        emissions: emission ? [emission] : [],
        data: snapshot,
      };
    }
    if (poll.chat_id !== ctx.chatId) {
      throw new Error("That poll is not available in this chat.");
    }
    const planRow = this.planById(poll.plan_id);
    if (!planRow) {
      throw new Error("The poll's plan no longer exists.");
    }
    const emission = this.tallyEmission(ctx, poll, "status");
    const tally = this.computeTally(poll, ctx);
    return { emissions: emission ? [emission] : [], data: tally };
  }

  private finalizePlan(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const parsed = FinalizeSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error("finalize_plan received invalid fields.");
    }
    const plan = this.planForArgs(parsed.data.plan_id, ctx.chatId);
    if (!plan || plan.stage === "cancelled" || plan.stage === "done") {
      throw new Error("finalize_plan requires an active plan.");
    }
    const location = parsed.data.location ?? plan.location;
    const startsAt =
      parsed.data.starts_at === undefined
        ? plan.starts_at
        : parseDateTime(parsed.data.starts_at, ctx.now, ctx.tz);
    if (parsed.data.starts_at !== undefined && startsAt === null) {
      throw new Error(
        "finalize_plan could not resolve starts_at in the chat timezone.",
      );
    }
    const going = parsed.data.going
      ? this.resolveRequired(ctx.participants, parsed.data.going)
      : parseJsonArray(plan.going_json).length > 0
        ? parseJsonArray(plan.going_json)
        : parseJsonArray(plan.interested_json);
    if (!location || startsAt === null || going.length === 0) {
      throw new Error(
        "finalize_plan needs a known time, place, and attendee list.",
      );
    }
    this.db
      .query("DELETE FROM planning_delivery_events WHERE key = ? AND sent = 0")
      .run(`plan:${plan.id}:kickoff`);
    this.db
      .query(
        `UPDATE plans SET location = ?, starts_at = ?, going_json = ?, interested_json = ?,
          stage = 'ready_to_lock', proposed_at = NULL,
          stage_changed_at = CASE WHEN stage <> 'ready_to_lock' THEN ? ELSE stage_changed_at END
         WHERE id = ?`,
      )
      .run(
        location,
        startsAt,
        JSON.stringify(going),
        JSON.stringify(
          uniqueStrings([...parseJsonArray(plan.interested_json), ...going]),
        ),
        ctx.now,
        plan.id,
      );
    this.invalidateProposal(plan.id);
    const proposal = this.planById(plan.id);
    if (!proposal || !this.hasConcreteProposal(proposal)) {
      throw new Error("The plan proposal could not be persisted.");
    }
    const key = this.nextProposalKey(plan.id);
    this.db
      .query(
        `INSERT INTO planning_current_proposals (plan_id, key, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(plan_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at`,
      )
      .run(plan.id, key, ctx.now);
    const emission = this.delivery(
      ctx,
      this.renderProposal(proposal, ctx.tz, ctx.participants),
      key,
      { kind: "lock", id: plan.id },
    );
    return {
      emissions: emission ? [emission] : [],
      data: this.snapshotForRow(proposal),
    };
  }

  private nudge(args: Record<string, unknown>, ctx: ChatContext): ActionResult {
    const id = this.optionalInteger(args.poll_id ?? args.id);
    const plan = this.activePlan(ctx.chatId);
    const poll =
      id === null ? (plan ? this.openPoll(plan.id) : null) : this.pollById(id);
    if (!poll || poll.chat_id !== ctx.chatId) {
      throw new Error("nudge requires an active poll in this chat.");
    }
    const options = this.pollOptions(poll);
    const tally = this.computeTally(poll, ctx);
    const requested = Array.isArray(args.handles)
      ? this.resolveRequired(
          ctx.participants,
          args.handles.filter(
            (value): value is string => typeof value === "string",
          ),
        )
      : tally.missing;
    const handles = requested.filter((handle) =>
      tally.missing.includes(handle),
    );
    if (handles.length === 0) {
      return { emissions: [], data: { handles: [] } };
    }
    const names = handles.map((handle) =>
      this.displayHandle(ctx.participants, handle),
    );
    const text = `${names.join(" ")}, we just need your votes for POLL #${poll.id} to lock this in!`;
    const emission = this.delivery(
      ctx,
      text,
      `poll:${poll.id}:nudge:${handles.join(",")}`,
      {
        kind: "poll",
        id: poll.id,
      },
    );
    return {
      emissions: emission ? [emission] : [],
      data: { handles, options },
    };
  }

  private scheduleReminder(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const parsed = ReminderSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error("schedule_reminder requires fire_at.");
    }
    const plan = this.planForArgs(parsed.data.plan_id, ctx.chatId);
    if (!plan || plan.stage === "cancelled" || plan.stage === "done") {
      throw new Error("schedule_reminder requires an active plan.");
    }
    const fireAt = parseDateTime(parsed.data.fire_at, ctx.now, ctx.tz);
    if (fireAt === null || fireAt <= ctx.now) {
      throw new Error(
        "schedule_reminder fire_at must be a future date in the chat timezone.",
      );
    }
    const text = this.defaultReminder(plan, fireAt, ctx.tz);
    const inserted = this.db
      .query(
        `INSERT INTO reminders (chat_id, plan_id, fire_at, text, kind, sent)
         VALUES (?, ?, ?, ?, 'custom', 0)`,
      )
      .run(ctx.chatId, plan.id, fireAt, text);
    return {
      emissions: [],
      data: { id: Number(inserted.lastInsertRowid), fireAt, text },
    };
  }

  private askClarify(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const parsed = ClarifySchema.safeParse(args);
    if (!parsed.success) {
      throw new Error("ask_clarify requires a question.");
    }
    const options = parsed.data.options ? uniqueStrings(parsed.data.options) : [];
    const text =
      options.length >= 2
        ? `Quick question: ${parsed.data.question}\n${options.map((option, index) => `${index + 1}) ${option}`).join("\n")}`
        : parsed.data.question;
    const plan = this.activePlan(ctx.chatId);
    const resourceId = plan?.id ?? 0;
    const emission = this.delivery(
      ctx,
      text,
      `clarify:${ctx.chatId}:${resourceId}:${ctx.now}`,
      {
        kind: "lock",
        id: resourceId,
      },
    );
    return { emissions: emission ? [emission] : [] };
  }

  private cancelPlan(
    args: Record<string, unknown>,
    ctx: ChatContext,
  ): ActionResult {
    const id = this.optionalInteger(args.plan_id ?? args.id);
    const plan = this.planForArgs(id, ctx.chatId);
    if (!plan) {
      return { emissions: [], data: { cancelled: false } };
    }
    this.invalidateProposal(plan.id);
    this.db
      .query("DELETE FROM planning_current_locks WHERE plan_id = ?")
      .run(plan.id);
    this.db
      .query(
        "UPDATE plans SET stage = 'cancelled', locked_at = NULL, stage_changed_at = ? WHERE id = ?",
      )
      .run(ctx.now, plan.id);
    this.db
      .query(
        "UPDATE polls SET status = 'closed', closed_at = COALESCE(closed_at, ?) WHERE plan_id = ? AND status = 'open'",
      )
      .run(ctx.now, plan.id);
    this.db
      .query("DELETE FROM reminders WHERE plan_id = ? AND sent = 0")
      .run(plan.id);
    return { emissions: [], data: { cancelled: true, planId: plan.id } };
  }

  private calendarInvite(ctx: ChatContext): ActionResult {
    const plan = this.activePlan(ctx.chatId);
    if (!plan) {
      return {
        emissions: [
          {
            chatId: ctx.chatId,
            text: "No active plan yet. Start one with /plan Dinner | dinner | Friday at 7pm.",
            key: `plan:invite:none:${ctx.now}`,
          },
        ],
      };
    }
    const icsPath = generateIcsFile(plan, ctx.now);
    const when = plan.starts_at ? formatAbsolute(plan.starts_at, ctx.tz) : "TBD";
    const text = `Calendar Event: ${plan.title}\nWhat: ${plan.what}\nWhere: ${plan.location ?? "TBD"}\nWhen: ${when}\n(Tap attached invite to add to Apple Calendar)`;
    const key = `plan:${plan.id}:invite:${ctx.now}`;
    const emission = this.delivery(
      ctx,
      text,
      key,
      { kind: "lock", id: plan.id },
      [icsPath],
    );
    return {
      emissions: emission ? [emission] : [],
      data: { planId: plan.id, icsPath },
    };
  }

  private handleCommand(
    ctx: ChatContext,
    message: IncomingMessage,
  ): ActionResult | null {
    const [command, ...rest] = message.text.trim().split(/\s+/u);
    const body = rest.join(" ").trim();
    switch (command.toLowerCase()) {
      case "/plan": {
        if (!body) {
          return null;
        }
        const fields = body
          .split("|")
          .map((value) => value.trim())
          .filter(Boolean);
        const title = fields[0];
        const what = fields[1] ?? title;
        const location = fields[2] ?? undefined;
        return this.execute(
          "start_plan",
          { title, what, location },
          { ...ctx, explicit: true, message },
        );
      }
      case "/poll": {
        const fields = body
          .split("|")
          .map((value) => value.trim())
          .filter(Boolean);
        const closesIndex = fields.findIndex((value) =>
          /^closes\s+/iu.test(value),
        );
        if (fields.length < 3 || closesIndex < 0) {
          return null;
        }
        const closes = fields
          .splice(closesIndex, 1)[0]
          .replace(/^closes\s+/iu, "");
        const [question, ...options] = fields;
        return this.execute(
          "create_poll",
          { question, options, closes_at: closes },
          { ...ctx, explicit: true, message },
        );
      }
      case "/status":
        return this.execute(
          "get_poll_status",
          {},
          { ...ctx, explicit: true, message },
        );
      case "/remind": {
        if (!body) {
          return null;
        }
        return this.execute(
          "schedule_reminder",
          { fire_at: body },
          { ...ctx, explicit: true, message },
        );
      }
      case "/cancel":
        return this.execute(
          "cancel_plan",
          {},
          { ...ctx, explicit: true, message },
        );
      case "/help": {
        const emission = this.delivery(
          ctx,
          "Mi Amigo can plan a hangout with /plan, /poll, /status, /remind, and /cancel. Reply to an open poll with numbers, none, or all.",
          `help:${ctx.chatId}`,
          { kind: "lock", id: 0 },
        );
        return { emissions: emission ? [emission] : [] };
      }
      default:
        return null;
    }
  }

  private recordVote(
    ctx: ChatContext,
    poll: PollRow,
    handle: string,
    choices: number[],
  ): ActionResult {
    if (poll.status !== "open" || poll.closes_at <= ctx.now) {
      return { emissions: [], data: { accepted: false, reason: "closed" } };
    }
    this.db
      .query(
        `INSERT INTO votes (poll_id, handle, choices_json, updated_at, source)
         VALUES (?, ?, ?, ?, 'explicit')
         ON CONFLICT(poll_id, handle) DO UPDATE SET choices_json = excluded.choices_json,
           updated_at = excluded.updated_at, source = 'explicit'`,
      )
      .run(poll.id, handle, JSON.stringify(choices), ctx.now);
    this.invalidatePendingTallies(poll.id);
    const latest = this.pollById(poll.id);
    if (!latest) {
      return { emissions: [], data: { accepted: true, choices } };
    }
    const tally = this.computeTally(latest, ctx);
    const complete = tally.missing.length === 0 && ctx.participants.length > 0;
    const shouldTally =
      complete ||
      latest.last_tally_at === null ||
      ctx.now - latest.last_tally_at >= TALLY_THROTTLE_MS;
    if (!shouldTally) {
      return { emissions: [], data: { accepted: true, choices, tally } };
    }
    this.db
      .query("UPDATE polls SET last_tally_at = ? WHERE id = ?")
      .run(ctx.now, poll.id);
    const plan = this.planById(poll.plan_id);
    const emission = plan ? this.tallyEmission(ctx, latest, "vote") : null;
    return {
      emissions: emission ? [emission] : [],
      data: { accepted: true, choices, tally },
    };
  }

  private confirmPlan(planId: number, ctx: ChatContext): ActionResult {
    const plan = this.planById(planId);
    if (
      !plan ||
      plan.chat_id !== ctx.chatId ||
      !this.currentProposalWasDelivered(plan)
    ) {
      return { emissions: [] };
    }
    const lock = this.lockPlan(plan, ctx);
    return { emissions: lock ? [lock] : [], data: this.snapshot(ctx.chatId) };
  }

  private lockPlan(plan: PlanRow, ctx: ChatContext): Emission | null {
    if (plan.stage === "locked" || !this.currentProposalWasDelivered(plan)) {
      return null;
    }
    const going =
      parseJsonArray(plan.going_json).length > 0
        ? parseJsonArray(plan.going_json)
        : parseJsonArray(plan.interested_json);
    if (!plan.location || plan.starts_at === null || going.length === 0) {
      return null;
    }
    const lockKey = this.nextLockKey(plan.id, ctx.now);
    this.db
      .query(
        `UPDATE plans SET stage = 'locked', locked_at = ?,
          going_json = ?, stage_changed_at = ? WHERE id = ?`,
      )
      .run(ctx.now, JSON.stringify(going), ctx.now, plan.id);
    this.db
      .query(
        `INSERT INTO planning_current_locks (plan_id, key, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(plan_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at`,
      )
      .run(plan.id, lockKey, ctx.now);
    this.db
      .query("DELETE FROM planning_current_proposals WHERE plan_id = ?")
      .run(plan.id);
    this.scheduleLockReminders(plan, ctx, ctx.now);
    const locked = this.planById(plan.id);
    if (!locked) {
      return null;
    }
    const icsPath = generateIcsFile(locked, ctx.now);
    return this.delivery(
      ctx,
      this.renderLock(locked, ctx.tz, ctx.participants),
      lockKey,
      { kind: "lock", id: plan.id },
      [icsPath],
    );
  }

  private scheduleLockReminders(
    plan: PlanRow,
    ctx: ChatContext,
    now: number,
  ): void {
    if (plan.starts_at === null || !plan.location) {
      return;
    }
    const reminders = [
      {
        fireAt: plan.starts_at - DAY_MS,
        kind: "day_before" as const,
        text: `Reminder: ${plan.what} @ ${plan.location} is TOMORROW, ${formatReminderTime(plan.starts_at, ctx.tz)}.`,
      },
      {
        fireAt: plan.starts_at - HOUR_MS,
        kind: "hour_before" as const,
        text: `Reminder: ${plan.what} @ ${plan.location} is in 1 hour, ${formatReminderTime(plan.starts_at, ctx.tz)}.`,
      },
    ];
    for (const reminder of reminders) {
      if (reminder.fireAt <= now) {
        continue;
      }
      this.db
        .query(
          `INSERT INTO reminders (chat_id, plan_id, fire_at, text, kind, sent)
           SELECT ?, ?, ?, ?, ?, 0
           WHERE NOT EXISTS (
             SELECT 1 FROM reminders WHERE plan_id = ? AND kind = ? AND sent = 0
           )`,
        )
        .run(
          ctx.chatId,
          plan.id,
          reminder.fireAt,
          reminder.text,
          reminder.kind,
          plan.id,
          reminder.kind,
        );
    }
  }

  private reopenPlan(planId: number, now: number): void {
    const plan = this.planById(planId);
    if (!plan || plan.stage === "cancelled") {
      return;
    }
    const times = parseJsonArray(plan.time_options_json);
    const places = parseJsonArray(plan.place_options_json);
    const stage: Stage =
      times.length > 0
        ? "choosing_time"
        : places.length > 0
          ? "choosing_place"
          : parseJsonArray(plan.interested_json).length < 2
            ? "idea"
            : "gathering";
    this.invalidateProposal(planId);
    this.db
      .query("DELETE FROM planning_delivery_events WHERE key = ? AND sent = 0")
      .run(`plan:${planId}:kickoff`);
    this.db
      .query("DELETE FROM planning_current_locks WHERE plan_id = ?")
      .run(planId);
    this.db
      .query(
        "UPDATE plans SET stage = ?, proposed_at = NULL, locked_at = NULL, stage_changed_at = ? WHERE id = ?",
      )
      .run(stage, now, planId);
    this.db
      .query("DELETE FROM reminders WHERE plan_id = ? AND sent = 0")
      .run(planId);
  }

  private mergeAvailability(
    planId: number,
    handle: string,
    value: { yes?: unknown; no?: unknown; maybe?: unknown },
    ctx: ChatContext,
  ): boolean {
    const answers: Array<["yes" | "no" | "maybe", unknown]> = [
      ["yes", value.yes],
      ["no", value.no],
      ["maybe", value.maybe],
    ];
    let changed = false;
    for (const [answer, options] of answers) {
      for (const option of stringArray(options)) {
        const normalized = this.normalizeTimeOption(option, ctx);
        if (!normalized) {
          continue;
        }
        const existing = this.one<{ answer: "yes" | "no" | "maybe" }>(
          "SELECT answer FROM availability WHERE plan_id = ? AND handle = ? AND option = ?",
          [planId, handle, normalized],
        );
        if (existing?.answer === answer) {
          continue;
        }
        this.db
          .query(
            `INSERT INTO availability (plan_id, handle, option, answer, source, updated_at)
             VALUES (?, ?, ?, ?, 'chat', ?)
             ON CONFLICT(plan_id, handle, option) DO UPDATE SET answer = excluded.answer,
               source = excluded.source, updated_at = excluded.updated_at`,
          )
          .run(planId, handle, normalized, answer, ctx.now);
        changed = true;
      }
    }
    this.syncAvailabilityVotes(planId, handle, ctx);
    return changed;
  }

  private syncAvailabilityVotes(
    planId: number,
    handle: string,
    ctx: ChatContext,
  ): void {
    const polls = this.all<PollRow>(
      `SELECT id, plan_id, chat_id, question, options_json, closes_at, status,
          created_at, closed_at, last_tally_at
       FROM polls WHERE plan_id = ? AND status = 'open' AND closes_at > ?
       ORDER BY id`,
      [planId, ctx.now],
    );
    for (const poll of polls) {
      const options = this.pollOptions(poll);
      const availability = this.all<AvailabilityRow>(
        "SELECT handle, option, answer FROM availability WHERE plan_id = ? AND handle = ?",
        [planId, handle],
      );
      const choices = new Set<number>();
      let responded = false;
      for (const row of availability) {
        const matches: number[] = [];
        const key = this.optionKey(row.option, ctx);
        for (const [index, option] of options.entries()) {
          if (this.optionKey(option, ctx) === key) {
            matches.push(index);
          }
        }
        if (matches.length !== 1) {
          continue;
        }
        responded = true;
        if (row.answer === "yes") {
          choices.add(matches[0]);
        }
      }
      const existing = this.one<{ choices_json: string; source: string }>(
        "SELECT choices_json, source FROM votes WHERE poll_id = ? AND handle = ?",
        [poll.id, handle],
      );
      if (existing?.source === "explicit") {
        continue;
      }
      const sortedChoices = [...choices].sort((left, right) => left - right);
      const choicesJson = JSON.stringify(sortedChoices);
      const changed = responded
        ? existing?.choices_json !== choicesJson ||
          existing?.source !== "availability"
        : existing?.source === "availability";
      if (!changed) {
        continue;
      }
      if (responded) {
        this.db
          .query(
            `INSERT INTO votes (poll_id, handle, choices_json, updated_at, source)
             VALUES (?, ?, ?, ?, 'availability')
             ON CONFLICT(poll_id, handle) DO UPDATE SET choices_json = excluded.choices_json,
               updated_at = excluded.updated_at, source = 'availability'
             WHERE votes.source = 'availability'`,
          )
          .run(poll.id, handle, choicesJson, ctx.now);
      } else {
        this.db
          .query(
            "DELETE FROM votes WHERE poll_id = ? AND handle = ? AND source = 'availability'",
          )
          .run(poll.id, handle);
      }
      this.invalidatePendingTallies(poll.id);
    }
  }

  private normalizeTimeOptions(
    values: readonly string[],
    ctx: ChatContext,
  ): string[] {
    return uniqueStrings(
      values.map((value) => this.normalizeTimeOption(value, ctx)),
    );
  }

  private normalizeTimeOption(value: string, ctx: ChatContext): string {
    const normalized = value.trim();
    if (!normalized) {
      return "";
    }
    const parsed = parseDateTime(normalized, ctx.now, ctx.tz);
    if (parsed === null) {
      return normalized;
    }
    const includesTime =
      /(?:\d{1,2}:\d{2}|\b(?:am|pm|morning|afternoon|evening|night|brunch|noon)\b)/iu.test(
        normalized,
      );
    return includesTime
      ? formatAbsolute(parsed, ctx.tz)
      : formatDateOnly(parsed, ctx.tz);
  }

  private optionKey(value: string, ctx: ChatContext): string {
    return this.normalizeTimeOption(value, ctx)
      .toLowerCase()
      .replace(/\s+/gu, " ");
  }

  private stageAfterMerge(
    plan: PlanRow,
    interested: readonly string[],
    going: readonly string[],
    timeOptions: readonly string[],
    placeOptions: readonly string[],
    startsAt: number | null,
    location: string | null,
    ctx: ChatContext,
    stateChanged: boolean,
  ): Stage {
    if (
      plan.stage === "locked" ||
      plan.stage === "done" ||
      plan.stage === "cancelled"
    ) {
      return plan.stage;
    }
    if (interested.length < 2) {
      return "idea";
    }
    if (plan.stage === "ready_to_lock" && !stateChanged) {
      return "ready_to_lock";
    }

    const timeWinner = this.majorityOptionIndex(plan.id, timeOptions, ctx);
    const placeWinner = this.majorityOptionIndex(plan.id, placeOptions, ctx);
    const timeConsensus = timeWinner !== null;
    const placeConsensus = placeWinner !== null;
    const timeMatches =
      startsAt !== null &&
      timeWinner !== null &&
      this.timeOptionMatches(timeOptions[timeWinner], startsAt, ctx);
    const placeMatches =
      location !== null &&
      placeWinner !== null &&
      this.optionKey(placeOptions[placeWinner], ctx) ===
        this.optionKey(location, ctx);

    if (
      startsAt !== null &&
      location &&
      going.length >= 2 &&
      timeConsensus &&
      placeConsensus &&
      timeMatches &&
      placeMatches
    ) {
      return "ready_to_lock";
    }
    if (timeOptions.length > 0 && !timeConsensus) {
      return "choosing_time";
    }
    if (timeOptions.length > 0 && placeOptions.length === 0) {
      return "choosing_time";
    }
    if (placeOptions.length > 0) {
      return "choosing_place";
    }
    if (timeOptions.length > 0) {
      return "choosing_time";
    }
    return "gathering";
  }

  private majorityOptionIndex(
    planId: number,
    options: readonly string[],
    ctx: ChatContext,
  ): number | null {
    if (options.length === 0) {
      return null;
    }
    const optionKeys = options.map((option) => this.optionKey(option, ctx));
    const polls = this.all<PollRow>(
      `SELECT id, plan_id, chat_id, question, options_json, closes_at, status,
          created_at, closed_at, last_tally_at
       FROM polls WHERE plan_id = ? ORDER BY id DESC`,
      [planId],
    );
    for (const poll of polls) {
      const pollOptions = this.pollOptions(poll);
      const mappedOptions = pollOptions.map((option) => {
        const matches = optionKeys.flatMap((key, index) =>
          key === this.optionKey(option, ctx) ? [index] : [],
        );
        return matches.length === 1 ? matches[0] : -1;
      });
      if (
        mappedOptions.length === 0 ||
        mappedOptions.some((index) => index < 0) ||
        new Set(mappedOptions).size !== mappedOptions.length
      ) {
        continue;
      }
      const tally = this.computeTally(poll, ctx);
      const winner = this.clearMajority(tally.counts, tally.voted.length);
      return winner === null ? null : (mappedOptions[winner] ?? null);
    }

    const availability = this.all<AvailabilityRow>(
      "SELECT handle, option, answer FROM availability WHERE plan_id = ?",
      [planId],
    );
    const counts = Array.from({ length: options.length }, () => 0);
    const responded = new Set<string>();
    for (const row of availability) {
      const matches = optionKeys.flatMap((key, index) =>
        key === this.optionKey(row.option, ctx) ? [index] : [],
      );
      if (matches.length !== 1) {
        continue;
      }
      responded.add(row.handle);
      if (row.answer === "yes") {
        counts[matches[0]] += 1;
      }
    }
    const winner = this.clearMajority(counts, responded.size);
    return winner;
  }

  private clearMajority(
    counts: readonly number[],
    responses: number,
  ): number | null {
    if (responses === 0) {
      return null;
    }
    let winner = -1;
    let largest = 0;
    let tied = false;
    for (const [index, count] of counts.entries()) {
      if (count > largest) {
        winner = index;
        largest = count;
        tied = false;
      } else if (count === largest && count > 0) {
        tied = true;
      }
    }
    return largest > responses / 2 && !tied ? winner : null;
  }

  private timeOptionMatches(
    option: string,
    startsAt: number,
    ctx: ChatContext,
  ): boolean {
    const optionHasTime =
      /(?:\d{1,2}:\d{2}|\b(?:am|pm|morning|afternoon|evening|night|brunch|noon)\b)/iu.test(
        option,
      );
    const parsedOption = parseDateTime(option, ctx.now, ctx.tz);
    if (parsedOption === null) {
      return false;
    }
    return optionHasTime
      ? parsedOption === startsAt
      : formatDateOnly(parsedOption, ctx.tz) ===
          formatDateOnly(startsAt, ctx.tz);
  }

  private computeTally(poll: PollRow, ctx: ChatContext): PollTally {
    const rows = this.all<VoteRow>(
      "SELECT handle, choices_json FROM votes WHERE poll_id = ? ORDER BY handle",
      [poll.id],
    );
    const votes = new Map<string, unknown>();
    for (const row of rows) {
      votes.set(row.handle, { choices: parseJsonNumbers(row.choices_json) });
    }
    const handles = ctx.participants.map((participant) => participant.handle);
    return tallyVotes(this.pollOptions(poll).length, handles, votes);
  }

  private tallyEmission(
    ctx: ChatContext,
    poll: PollRow,
    phase: "status" | "vote" | "closed",
  ): Emission | null {
    const tally = this.computeTally(poll, ctx);
    const suffix = `${tally.counts.join(",")}:${tally.voted.join(",")}:${tally.missing.join(",")}`;
    const key = `poll:${poll.id}:tally:${phase}:${suffix}`;
    this.invalidatePendingTallies(poll.id, key);
    const text = this.renderTally(poll, tally, ctx);
    return this.delivery(ctx, text, key, { kind: "poll", id: poll.id });
  }

  private renderKickoff(plan: PlanRow, timeZone: string): string {
    const location = plan.location ?? "TBD";
    const starts =
      plan.starts_at === null
        ? "TBD"
        : formatAbsolute(plan.starts_at, timeZone);
    return `New plan: ${plan.title}\nWhat: ${plan.what}\nWhere: ${location}\nWhen: ${starts}\nNext step: vote on a day`;
  }

  private renderPoll(
    poll: PollRow,
    options: readonly string[],
    timeZone: string,
    participants?: readonly Participant[],
  ): string {
    const pings =
      participants && participants.length > 0
        ? participants.map((p) => this.displayHandle(participants, p.handle)).join("\n")
        : "";
    const prefix = pings ? `${pings}\n\n` : "";
    const hint =
      options.length === 2
        ? "Reply with 1 or 2."
        : `Reply with your choice(s), e.g. "1" or "1 2".`;
    return [
      `${prefix}POLL #${poll.id}: ${poll.question}`,
      ...options.map((option, index) => `${index + 1}) ${option}`),
      `${hint} Closes ${formatPollClose(poll.closes_at, timeZone)}.`,
    ].join("\n");
  }

  private renderTally(
    poll: PollRow,
    tally: PollTally,
    ctx: ChatContext,
  ): string {
    const options = this.pollOptions(poll);
    const max = Math.max(...tally.counts, 0);
    const lines = options.map((option, index) => {
      const bars = "▓".repeat(Math.min(tally.counts[index] ?? 0, 12));
      const leading =
        max > 0 && tally.counts[index] === max ? "  ← leading" : "";
      return `${index + 1}) ${option} ${bars} ${tally.counts[index] ?? 0}${leading}`.trimEnd();
    });
    const total =
      ctx.participants.length > 0
        ? ctx.participants.length
        : tally.voted.length;
    const waiting = tally.missing.map((handle) =>
      this.displayHandle(ctx.participants, handle),
    );
    const suffix =
      waiting.length > 0 ? `\nStill waiting on: ${waiting.join(", ")}` : "";
    return `POLL #${poll.id} so far (${tally.voted.length}/${total} voted)\n${lines.join("\n")}${suffix}`;
  }

  private renderProposal(
    plan: PlanRow,
    timeZone: string,
    participants: readonly ParticipantLike[],
  ): string {
    const going = parseJsonArray(plan.going_json)
      .map(
        (handle) =>
          participants.find((participant) => participant.handle === handle)
            ?.name ?? handle,
      )
      .join(", ");
    return `PROPOSED: ${plan.what} @ ${plan.location}\nWhen: ${formatAbsolute(plan.starts_at as number, timeZone)}\nGoing: ${going}\nReply "yes" to lock, or object within 10 minutes.`;
  }

  private renderLock(
    plan: PlanRow,
    timeZone: string,
    participants: readonly ParticipantLike[],
  ): string {
    const going = parseJsonArray(plan.going_json)
      .map(
        (handle) =>
          participants.find((participant) => participant.handle === handle)
            ?.name ?? handle,
      )
      .join(", ");
    return `LOCKED IN: ${plan.what} @ ${plan.location}\nWhen: ${formatAbsolute(plan.starts_at as number, timeZone)}\nGoing: ${going}\nI'll remind everyone the day before and 1 hour before.`;
  }

  private renderStatus(
    plan: PlanRow,
    timeZone: string,
    snapshot: PlanSnapshot,
  ): string {
    const starts =
      plan.starts_at === null
        ? "TBD"
        : formatAbsolute(plan.starts_at, timeZone);
    const availability = Object.entries(snapshot.availability)
      .map(([handle, values]) => {
        const yes = values.yes.length > 0 ? `yes ${values.yes.join(", ")}` : "";
        const no = values.no.length > 0 ? `no ${values.no.join(", ")}` : "";
        const maybe =
          values.maybe.length > 0 ? `maybe ${values.maybe.join(", ")}` : "";
        return `${handle}: ${[yes, no, maybe].filter(Boolean).join("; ")}`;
      })
      .filter(Boolean);
    const options = [
      snapshot.timeOptions.length > 0
        ? `Times: ${snapshot.timeOptions.join(", ")}`
        : "",
      snapshot.placeOptions.length > 0
        ? `Places: ${snapshot.placeOptions.join(", ")}`
        : "",
      availability.length > 0 ? `Availability: ${availability.join("  ")}` : "",
    ].filter(Boolean);
    return `Plan: ${plan.title}\nWhat: ${plan.what}\nWhere: ${plan.location ?? "TBD"}\nWhen: ${starts}\nStage: ${plan.stage}${options.length > 0 ? `\n${options.join("\n")}` : ""}`;
  }

  private defaultReminder(
    plan: PlanRow,
    fireAt: number,
    timeZone: string,
  ): string {
    const start =
      plan.starts_at === null
        ? formatDateOnly(fireAt, timeZone)
        : formatReminderTime(plan.starts_at, timeZone);
    return `Reminder: ${plan.what}${plan.location ? ` @ ${plan.location}` : ""} is coming up, ${start}.`;
  }

  private snapshotForRow(plan: PlanRow): PlanSnapshot {
    const availability: PlanSnapshot["availability"] = {};
    const rows = this.all<AvailabilityRow>(
      "SELECT handle, option, answer FROM availability WHERE plan_id = ? ORDER BY handle, option",
      [plan.id],
    );
    for (const row of rows) {
      availability[row.handle] ??= { yes: [], no: [], maybe: [] };
      availability[row.handle][row.answer].push(row.option);
    }
    const openPoll = this.openPoll(plan.id);
    return {
      id: plan.id,
      title: plan.title,
      what: plan.what,
      location: plan.location,
      startsAt: plan.starts_at,
      stage: plan.stage,
      going: parseJsonArray(plan.going_json),
      interested: parseJsonArray(plan.interested_json),
      timeOptions: parseJsonArray(plan.time_options_json),
      placeOptions: parseJsonArray(plan.place_options_json),
      availability,
      proposedAt: plan.proposed_at,
      lockedAt: plan.locked_at,
      stageChangedAt: plan.stage_changed_at,
      openPoll: openPoll
        ? {
            id: openPoll.id,
            question: openPoll.question,
            options: this.pollOptions(openPoll),
            voted: this.all<VoteRow>(
              "SELECT handle, choices_json FROM votes WHERE poll_id = ? ORDER BY handle",
              [openPoll.id],
            ).map((vote) => vote.handle),
          }
        : undefined,
    };
  }

  private activePlan(chatId: string): PlanRow | null {
    return this.one<PlanRow>(
      `SELECT id, chat_id, title, what, location, starts_at, stage,
          interested_json, going_json, time_options_json, place_options_json,
          extracted_json, stage_changed_at, proposed_at, locked_at, created_at,
          spoke_in_stage
       FROM plans WHERE chat_id = ? AND stage NOT IN ('done', 'cancelled')
       ORDER BY id DESC LIMIT 1`,
      [chatId],
    );
  }

  private planById(id: number): PlanRow | null {
    return this.one<PlanRow>(
      `SELECT id, chat_id, title, what, location, starts_at, stage,
          interested_json, going_json, time_options_json, place_options_json,
          extracted_json, stage_changed_at, proposed_at, locked_at, created_at,
          spoke_in_stage
       FROM plans WHERE id = ?`,
      [id],
    );
  }

  private planForArgs(
    id: number | null | undefined,
    chatId: string,
  ): PlanRow | null {
    if (id === null || id === undefined) {
      return this.activePlan(chatId);
    }
    const plan = this.planById(id);
    return plan?.chat_id === chatId ? plan : null;
  }

  private pollById(id: number): PollRow | null {
    return this.one<PollRow>(
      `SELECT id, plan_id, chat_id, question, options_json, closes_at, status,
          created_at, closed_at, last_tally_at FROM polls WHERE id = ?`,
      [id],
    );
  }

  private openPoll(planId: number): PollRow | null {
    return this.one<PollRow>(
      `SELECT id, plan_id, chat_id, question, options_json, closes_at, status,
          created_at, closed_at, last_tally_at FROM polls
       WHERE plan_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
      [planId],
    );
  }

  private latestPoll(planId: number): PollRow | null {
    return this.one<PollRow>(
      `SELECT id, plan_id, chat_id, question, options_json, closes_at, status,
          created_at, closed_at, last_tally_at FROM polls
       WHERE plan_id = ? ORDER BY id DESC LIMIT 1`,
      [planId],
    );
  }

  private statusKey(plan: PlanRow): string {
    const snapshot = this.snapshotForRow(plan);
    return `status:${plan.id}:${plan.stage_changed_at}:${JSON.stringify({
      interested: snapshot.interested,
      timeOptions: snapshot.timeOptions,
      placeOptions: snapshot.placeOptions,
      availability: snapshot.availability,
    })}`;
  }

  private invalidateProposal(planId: number): void {
    this.db
      .query("DELETE FROM planning_current_proposals WHERE plan_id = ?")
      .run(planId);
    this.db
      .query("UPDATE plans SET proposed_at = NULL WHERE id = ?")
      .run(planId);
  }

  private nextProposalKey(planId: number): string {
    const prefix = `plan:${planId}:proposal:`;
    const row = this.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM planning_delivery_events WHERE key LIKE ?",
      [`${prefix}%`],
    );
    return `${prefix}${(row?.count ?? 0) + 1}`;
  }

  private nextLockKey(planId: number, now: number): string {
    const prefix = `plan:${planId}:lock:${now}:`;
    const row = this.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM planning_delivery_events WHERE key LIKE ?",
      [`plan:${planId}:lock:%`],
    );
    return `${prefix}${(row?.count ?? 0) + 1}`;
  }

  private hasConcreteProposal(plan: PlanRow): boolean {
    return Boolean(
      plan.location?.trim() &&
        plan.starts_at !== null &&
        Number.isFinite(plan.starts_at) &&
        parseJsonArray(plan.going_json).length > 0,
    );
  }

  private isCurrentProposalKey(planId: number, key: string): boolean {
    const current = this.one<{ key: string }>(
      "SELECT key FROM planning_current_proposals WHERE plan_id = ?",
      [planId],
    );
    return current?.key === key;
  }

  private isCurrentDeliveredProposal(
    plan: PlanRow,
    event: DeliveryRow,
  ): boolean {
    return (
      plan.stage === "ready_to_lock" &&
      plan.proposed_at !== null &&
      this.hasConcreteProposal(plan) &&
      event.resource_id === plan.id &&
      event.sent === 1 &&
      event.created_at === plan.proposed_at &&
      this.isCurrentProposalKey(plan.id, event.key)
    );
  }

  private currentProposalWasDelivered(plan: PlanRow): boolean {
    if (plan.proposed_at === null || !this.hasConcreteProposal(plan)) {
      return false;
    }
    const event = this.one<DeliveryRow>(
      `SELECT event.key, event.chat_id, event.kind, event.resource_id, event.text,
          event.sent, event.guid, event.created_at
       FROM planning_current_proposals AS current
       JOIN planning_delivery_events AS event ON event.key = current.key
       WHERE current.plan_id = ? AND event.kind = 'lock' AND event.sent = 1`,
      [plan.id],
    );
    return Boolean(event && this.isCurrentDeliveredProposal(plan, event));
  }

  private invalidatePendingTallies(pollId: number, keepKey?: string): void {
    if (keepKey) {
      this.db
        .query(
          "DELETE FROM planning_delivery_events WHERE key LIKE ? AND key <> ? AND sent = 0",
        )
        .run(`poll:${pollId}:tally:%`, keepKey);
      return;
    }
    this.db
      .query(
        "DELETE FROM planning_delivery_events WHERE key LIKE ? AND sent = 0",
      )
      .run(`poll:${pollId}:tally:%`);
  }

  private pollOptions(poll: PollRow): string[] {
    return uniqueStrings(parseJsonArray(poll.options_json));
  }

  private delivery(
    ctx: ChatContext,
    text: string,
    key: string,
    tag: DeliveryTag,
    attachments?: string[],
  ): Emission | null {
    const existing = this.one<DeliveryRow>(
      `SELECT key, chat_id, kind, resource_id, text, sent, guid, created_at
       FROM planning_delivery_events WHERE key = ?`,
      [key],
    );
    if (existing?.sent === 1) {
      return null;
    }
    if (!existing) {
      this.db
        .query(
          `INSERT INTO planning_delivery_events
            (key, chat_id, kind, resource_id, text, sent, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(key, ctx.chatId, tag.kind, tag.id, text, ctx.now);
    }
    return { chatId: ctx.chatId, text, key, tag: { ...tag, key }, attachments };
  }

  private authorize(ctx: ChatContext): void {
    if (!this.resolveOne(ctx.participants, ctx.actor)) {
      throw new Error("Only a known participant can use planning commands.");
    }
  }

  private resolveRequired(
    participants: readonly ParticipantLike[],
    values: readonly string[],
  ): string[] {
    const result: string[] = [];
    for (const value of values) {
      const resolved = this.resolveOne(participants, value);
      if (!resolved) {
        throw new Error(`Unknown or ambiguous participant: ${value}`);
      }
      if (!result.includes(resolved)) {
        result.push(resolved);
      }
    }
    return result;
  }

  private resolveMany(
    participants: readonly ParticipantLike[],
    values: readonly string[],
  ): string[] {
    const result: string[] = [];
    for (const value of values) {
      const resolved = this.resolveOne(participants, value);
      if (resolved && !result.includes(resolved)) {
        result.push(resolved);
      }
    }
    return result;
  }

  private resolveOne(
    participants: readonly ParticipantLike[],
    value: string,
  ): string | null {
    const normalized = value.trim().replace(/^@/u, "").toLowerCase();
    if (!normalized) {
      return null;
    }
    const handles = participants.filter(
      (participant) => participant.handle.toLowerCase() === normalized,
    );
    if (handles.length === 1) {
      return handles[0].handle;
    }
    const names = participants.filter(
      (participant) => participant.name.trim().toLowerCase() === normalized,
    );
    return names.length === 1 ? names[0].handle : null;
  }

  private displayHandle(
    participants: readonly ParticipantLike[],
    handle: string,
  ): string {
    const participant = participants.find((entry) => entry.handle === handle);
    return `@${participant?.name || participant?.handle || handle}`;
  }

  private cleanText(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const text = value.trim();
    return text ? text : null;
  }

  private optionalInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : null;
  }

  private one<T>(sql: string, params: SQLQueryBindings[] = []): T | null {
    return this.db.query<T, SQLQueryBindings[]>(sql).get(...params) as T | null;
  }

  private all<T>(sql: string, params: SQLQueryBindings[] = []): T[] {
    return this.db.query<T, SQLQueryBindings[]>(sql).all(...params);
  }
}
function formatIcsTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function generateIcsFile(plan: PlanRow, now: number): string {
  const dtStamp = formatIcsTimestamp(now);
  const start = plan.starts_at ?? now + 24 * 60 * 60 * 1000;
  const dtStart = formatIcsTimestamp(start);
  const dtEnd = formatIcsTimestamp(start + 2 * 60 * 60 * 1000);
  const title = (plan.title || plan.what || "Group Event").replace(/[\r\n]/g, " ");
  const location = (plan.location || "").replace(/[\r\n]/g, " ");
  const description = `${plan.what || title} (Organized with Mi Amigo)`.replace(/[\r\n]/g, " ");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mi Amigo//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:miamigo-${plan.id}-${now}@dubhacks26`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const path = `/tmp/miamigo-event-${plan.id}.ics`;
  writeFileSync(path, ics, "utf8");
  return path;
}

function parseJsonNumbers(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is number => Number.isInteger(item) && item >= 0,
        )
      : [];
  } catch {
    return [];
  }
}

export const planningTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "start_plan",
      description:
        "Start a group plan with known details and render the fixed kickoff template.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          what: { type: "string" },
          activity: { type: "string" },
          location: { type: "string" },
          starts_at: { type: "string" },
          going: { type: "array", items: { type: "string" } },
          time_options: { type: "array", items: { type: "string" } },
          place_options: { type: "array", items: { type: "string" } },
          poll_question: { type: "string" },
          poll_closes_at: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_poll",
      description: "Create a text poll whose replies are parsed locally.",
      parameters: {
        type: "object",
        required: ["question", "options", "closes_at"],
        properties: {
          plan_id: { type: "integer" },
          title: { type: "string" },
          what: { type: "string" },
          activity: { type: "string" },
          location: { type: "string" },
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 12,
          },
          closes_at: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_poll_status",
      description:
        "Render a deterministic poll tally and missing participant list.",
      parameters: {
        type: "object",
        properties: { poll_id: { type: "integer" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finalize_plan",
      description:
        "Propose a plan using only known time, place, and attendees.",
      parameters: {
        type: "object",
        properties: {
          plan_id: { type: "integer" },
          location: { type: "string" },
          starts_at: { type: "string" },
          going: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nudge",
      description: "Mention only known participants still missing a poll vote.",
      parameters: {
        type: "object",
        properties: {
          poll_id: { type: "integer" },
          handles: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_reminder",
      description: "Persist a reminder before claiming that it is scheduled.",
      parameters: {
        type: "object",
        required: ["fire_at"],
        properties: {
          plan_id: { type: "integer" },
          fire_at: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarify",
      description: "Send a reminder, clarification note, or question to the group chat.",
      parameters: {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 4,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_invite",
      description: "Generate and send an interactive Apple Calendar (.ics) event invite to the chat.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  },
];
