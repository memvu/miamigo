import type { BackboardAI } from "./ai";
import type { Billing } from "./bills";
import type { Config } from "./config";
import type {
  ActionResult,
  ChatContext,
  Decision,
  DeliveryTag,
  IncomingMessage,
} from "./contracts";
import type { Store } from "./db";
import { Bursts, dayKey, passesGate, speakingPolicy } from "./passive";
import type { Planning } from "./planning";
import { tools } from "./tools";

const DAY = 86_400_000;
const BILL_TOOLS = new Set([
  "split_bill",
  "mark_paid",
  "adjust_share",
  "get_balances",
  "settle_bill",
  "forgive_share",
]);

export class Core {
  private readonly bursts = new Bursts();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly forgetting = new Set<string>();
  private readonly epochs = new Map<string, number>();
  private flushing = false;
  private flushJob: Promise<void> | null = null;
  private stopped = false;
  private lastScheduled = 0;
  private readonly mention: RegExp;
  private readonly shush: RegExp;

  constructor(
    readonly config: Config,
    readonly store: Store,
    private readonly planning: Planning,
    private readonly billing: Billing,
    private readonly ai: Pick<BackboardAI, "decide" | "forget">,
    private readonly send: (chatId: string, text: string) => Promise<void>,
    private readonly log: (event: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now,
  ) {
    const name = config.botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.mention = new RegExp(
      `(?:^|\\s)@${name}\\b|(?:^|\\s)${name}\\s*,`,
      "i",
    );
    this.shush = new RegExp(`^(?:${name}\\s+(?:shh|stop)|stop)[.! ]*$`, "i");
  }

  private context(
    chatId: string,
    actor = "",
    explicit = false,
    message?: IncomingMessage,
  ): ChatContext {
    return {
      chatId,
      now: this.now(),
      tz: this.store.chat(chatId).tz,
      botName: this.config.botName,
      actor,
      explicit,
      participants: this.store.participants(chatId),
      recent: this.store.recent(chatId),
      lastEvaluatedRowid: this.store.chat(chatId).last_eval_rowid,
      plan: this.planning.snapshot(chatId),
      bills: this.billing.snapshot(chatId),
      message,
    };
  }

  private deliverTags(
    tags: DeliveryTag[],
    guid: string | undefined,
    now: number,
  ): void {
    for (const tag of tags) {
      if (tag.kind === "bill" || tag.kind === "bill_nudge")
        this.billing.sent(tag, guid, now, tag.key);
      else this.planning.sent(tag, guid, now, tag.key);
    }
  }

  receive(message: IncomingMessage): void {
    if (
      this.stopped ||
      !this.config.allowedChats.has(message.chatId) ||
      (!message.isGroup && !this.config.allowDMs)
    )
      return;
    if (message.isFromMe) {
      const row = this.store.bindOutgoing(message);
      if (row) this.deliverTags(this.store.tags(row), message.id, message.at);
      return;
    }
    if (message.at < this.now() - 7 * DAY || !this.store.append(message))
      return;
    this.log({
      event: "incoming",
      timestamp: new Date(message.at).toISOString(),
      chat: message.chatId,
      sender: message.handle,
      type: message.kind,
      text: message.text,
      ...(message.reaction ? { reaction: message.reaction } : {}),
    });
    if (this.forgetting.has(message.chatId) || !message.handle) return;
    const ctx = this.context(message.chatId, message.handle, false, message);
    if (message.kind === "text" && !message.reaction)
      this.bursts.receive(message.chatId, this.now(), false);
    try {
      if (message.reaction) {
        const result =
          this.billing.handleReaction(ctx, message) ??
          this.planning.handleReaction(ctx, message);
        if (result) {
          this.engaged(message.chatId);
          this.queue(result);
        }
        return;
      }
      if (message.kind !== "text" || !message.text.trim()) return;
      const text = message.text.trim();
      if (this.shush.test(text)) {
        this.quiet(ctx);
        this.reply(message, "🤫 Quiet for 24 hours. Use /loud to resume.");
        return;
      }
      const command = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
      if (command) {
        this.engaged(message.chatId);
        this.command(
          { ...ctx, explicit: true },
          message,
          command[1].toLowerCase(),
          command[2]?.trim() ?? "",
        );
        return;
      }
      const local =
        this.billing.handleMessage(ctx, message) ??
        this.planning.handleMessage(ctx, message);
      if (local) {
        this.engaged(message.chatId);
        this.queue(local);
        return;
      }
      if (this.mention.test(text)) {
        this.engaged(message.chatId);
        this.explicit({ ...ctx, explicit: true });
        return;
      }
      if (!this.bursts.pending.has(message.chatId))
        this.bursts.receive(
          message.chatId,
          this.now(),
          passesGate(
            text,
            this.planning.hasActive(message.chatId),
            this.billing.hasOpen(message.chatId),
          ),
        );
    } catch (error) {
      this.logError(error, "local", message.chatId);
      // Local parse/authorization failures are actionable replies, not invented model answers.
      this.reply(
        message,
        `🤔 ${error instanceof Error ? error.message : "I could not process that request."}`,
      );
    }
  }

  private engaged(chatId: string): void {
    this.store.db
      .query("UPDATE chats SET unanswered_count=0 WHERE chat_id=?")
      .run(chatId);
  }

  private quiet(ctx: ChatContext): void {
    this.store.db
      .query(
        "UPDATE chats SET quiet_until=?,unanswered_count=0 WHERE chat_id=?",
      )
      .run(ctx.now + DAY, ctx.chatId);
    this.store.cancelQueued(ctx.chatId, true);
    this.bursts.pending.delete(ctx.chatId);
    this.epochs.set(ctx.chatId, (this.epochs.get(ctx.chatId) ?? 0) + 1);
  }

  private reply(message: IncomingMessage, text: string): void {
    this.store.queue(
      { chatId: message.chatId, text, key: `reply:${message.id}` },
      this.now(),
    );
  }

  private queue(result: ActionResult, scheduled = false): void {
    if (
      result.data &&
      typeof result.data === "object" &&
      "error" in result.data &&
      typeof result.data.error === "string"
    ) {
      throw new Error(result.data.error);
    }
    for (const emission of result.emissions)
      this.store.queue(
        emission,
        this.now(),
        false,
        scheduled ? "scheduled" : "",
      );
  }

  private command(
    ctx: ChatContext,
    message: IncomingMessage,
    name: string,
    args: string,
  ): void {
    switch (name) {
      case "quiet":
        this.quiet(ctx);
        this.reply(message, "🤫 Quiet for 24 hours. Use /loud to resume.");
        return;
      case "loud":
        this.store.db
          .query(
            "UPDATE chats SET quiet_until=0,unanswered_count=0 WHERE chat_id=?",
          )
          .run(ctx.chatId);
        this.reply(message, "👋 Passive planning is enabled again.");
        return;
      case "help":
        this.reply(
          message,
          "👋 Mi Amigo helps this group plan and split bills.\n/plan /poll /status /remind /cancel · /quiet /loud\n/split amount /paid [name] /owe /settle /forgive name · /forget\nSelected text is printed to the terminal and retained in SQLite for 7 days; terminal captures are not auto-pruned. Gated context goes to Backboard. /forget deletes this chat's saved state and AI memory, not terminal history.",
        );
        return;
      case "status":
        this.queue(this.planning.execute("get_poll_status", {}, ctx));
        return;
      case "cancel":
        this.epochs.set(ctx.chatId, (this.epochs.get(ctx.chatId) ?? 0) + 1);
        this.bursts.pending.delete(ctx.chatId);
        this.store.cancelQueued(ctx.chatId, true);
        this.queue(this.planning.execute("cancel_plan", {}, ctx));
        this.reply(message, "✅ The active plan is cancelled.");
        return;
      case "owe":
        this.queue(this.billing.execute("get_balances", {}, ctx));
        return;
      case "paid":
        this.queue(
          this.billing.execute("mark_paid", { person: args || ctx.actor }, ctx),
        );
        return;
      case "settle":
        this.queue(this.billing.execute("settle_bill", {}, ctx));
        return;
      case "forgive":
        this.queue(
          this.billing.execute("forgive_share", { person: args }, ctx),
        );
        return;
      case "split": {
        const amount = /^\$?(\d+(?:\.\d{1,2})?)(?:\s+(.*))?$/.exec(args);
        if (!amount) {
          this.reply(
            message,
            "🤔 Use /split 50 or /split 50 4 ways. Who paid?",
          );
          return;
        }
        this.queue(
          this.billing.execute(
            "split_bill",
            {
              total: Number(amount[1]),
              payer: ctx.actor,
              split_hint: amount[2] ?? null,
              includes_tip: "unknown",
            },
            ctx,
          ),
        );
        return;
      }
      case "forget":
        this.forget(ctx, message);
        return;
      case "plan":
      case "poll":
      case "remind": {
        const local = this.planning.handleMessage(ctx, message);
        if (local) this.queue(local);
        else
          this.reply(
            message,
            name === "plan"
              ? "📍 Use /plan Dinner | dinner | Cafe."
              : name === "poll"
                ? "🗳️ Use /poll Which day? | Friday | Saturday | closes tomorrow at 9pm."
                : "⏰ Use /remind tomorrow at 6pm. Start a plan first.",
          );
        return;
      }
      default:
        this.reply(
          message,
          "🤔 Unknown command. Use /help to see the available commands.",
        );
    }
  }

  private forget(ctx: ChatContext, message: IncomingMessage): void {
    this.forgetting.add(ctx.chatId);
    this.epochs.set(ctx.chatId, (this.epochs.get(ctx.chatId) ?? 0) + 1);
    this.bursts.pending.delete(ctx.chatId);
    this.launch(ctx.chatId, async () => {
      try {
        await this.ai.forget(ctx.chatId);
        this.planning.forget(ctx.chatId);
        this.billing.forget(ctx.chatId);
        this.store.forget(ctx.chatId);
        this.reply(
          message,
          "🧹 This chat's saved plans, bills, messages, and Backboard memory are deleted.",
        );
      } catch (error) {
        this.logError(error, "forget", ctx.chatId);
        this.reply(
          message,
          "😵 I could not finish deleting Backboard memory. Your state is retained so /forget can be tried again.",
        );
      } finally {
        this.forgetting.delete(ctx.chatId);
      }
    });
  }

  private launch(chatId: string, work: () => Promise<void>): void {
    const previous = this.jobs.get(chatId) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(work)
      .catch((error) => this.logError(error, "background", chatId));
    this.jobs.set(chatId, job);
    void job.finally(() => {
      if (this.jobs.get(chatId) === job) this.jobs.delete(chatId);
    });
  }

  private logError(error: unknown, operation: string, chatId: string): void {
    this.log({
      event: "error",
      operation,
      chat: chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private explicit(ctx: ChatContext): void {
    const epoch = this.epochs.get(ctx.chatId) ?? 0;
    this.launch(ctx.chatId, async () => {
      if (
        this.stopped ||
        this.forgetting.has(ctx.chatId) ||
        epoch !== (this.epochs.get(ctx.chatId) ?? 0)
      )
        return;
      try {
        const current = this.context(ctx.chatId, ctx.actor, true, ctx.message);
        this.act(current, await this.ai.decide(current, tools), false, "");
      } catch (error) {
        this.logError(error, "planner", ctx.chatId);
        if (
          ctx.message &&
          !this.stopped &&
          epoch === (this.epochs.get(ctx.chatId) ?? 0)
        )
          this.reply(
            ctx.message,
            "😵 Brain freeze: the model could not finish. Local commands like /status, /owe, and poll votes still work.",
          );
      }
    });
  }

  /** Runs the decision's single action locally; returns whether proactive output was queued. */
  private act(
    ctx: ChatContext,
    decision: Decision,
    proactive: boolean,
    stageKey: string,
  ): boolean {
    const epoch = this.epochs.get(ctx.chatId) ?? 0;
    const lastRow = ctx.recent.at(-1)?.rowid;
    let intent = decision.action;
    if (!intent || intent.name === "no_reply") return false;
    if (
      this.stopped ||
      this.forgetting.has(ctx.chatId) ||
      epoch !== (this.epochs.get(ctx.chatId) ?? 0)
    )
      throw new Error("The chat changed while the model was working.");
    if (proactive && this.store.recent(ctx.chatId).at(-1)?.rowid !== lastRow)
      throw new Error("New messages arrived; wait for the next lull.");
    if (!tools.some((tool) => tool.function.name === intent?.name))
      throw new Error("The model requested an unsupported tool.");
    if (proactive && intent.name === "split_bill") {
      const bill = decision.bill;
      if (
        !bill?.is_shared_expense ||
        bill.confidence < 0.8 ||
        bill.total === null ||
        bill.payer === null
      )
        return false;
      intent = {
        ...intent,
        args: {
          total: bill.total,
          payer: bill.payer,
          includes_tip: bill.includes_tip,
          split_hint: bill.split_hint,
          fixed_shares: bill.fixed_shares,
        },
      };
    }
    const current = this.context(
      ctx.chatId,
      ctx.actor,
      ctx.explicit,
      ctx.message,
    );
    const result = BILL_TOOLS.has(intent.name)
      ? this.billing.execute(intent.name, intent.args, current)
      : this.planning.execute(intent.name, intent.args, current);
    if (
      result.data &&
      typeof result.data === "object" &&
      "error" in result.data
    ) {
      if (!proactive && ctx.message)
        this.reply(ctx.message, `🤔 ${String(result.data.error)}`);
      return false;
    }
    if (!proactive || !result.emissions.length) {
      this.queue(result);
      return false;
    }
    const key = `proactive:${ctx.chatId}:${lastRow}:${stageKey}`;
    const text = result.emissions.map((emission) => emission.text).join("\n");
    if (
      !this.store.queue(
        { chatId: ctx.chatId, text, key },
        this.now(),
        true,
        stageKey,
      )
    )
      return false;
    const tags = result.emissions.flatMap((emission) =>
      emission.tag ? [{ ...emission.tag, key: emission.key }] : [],
    );
    this.store.db
      .query("UPDATE outbox SET tag_json=? WHERE event_key=?")
      .run(JSON.stringify(tags), key);
    const day = dayKey(this.now(), ctx.tz);
    this.store.db
      .query(
        "UPDATE chats SET proactive_today=CASE WHEN proactive_day=? THEN proactive_today+1 ELSE 1 END,proactive_day=?,spoke_stage=? WHERE chat_id=?",
      )
      .run(
        day,
        day,
        decision.bill?.is_shared_expense
          ? this.store.chat(ctx.chatId).spoke_stage
          : stageKey,
        ctx.chatId,
      );
    return true;
  }

  private evaluate(chatId: string): void {
    if (this.jobs.has(chatId) || this.forgetting.has(chatId)) return;
    const burst = this.bursts.pending.get(chatId);
    if (!burst) return;
    const version = burst.version;
    const epoch = this.epochs.get(chatId) ?? 0;
    this.launch(chatId, async () => {
      let decision = burst.decision;
      const recent = this.store.recent(chatId);
      const last = recent.at(-1);
      if (!last) {
        this.bursts.pending.delete(chatId);
        return;
      }
      const message: IncomingMessage = {
        id: last.id,
        chatId,
        handle: last.handle,
        text: last.text,
        at: last.at,
        isFromMe: false,
        isGroup: true,
        kind: "text",
      };
      let ctx = this.context(chatId, last.handle, false, message);
      try {
        if (burst.evaluated < version) {
          decision = await this.ai.decide(ctx, tools);
          if (this.stopped || epoch !== (this.epochs.get(chatId) ?? 0)) return;
          this.planning.merge(ctx, decision);
          const lastProactive = this.store.chat(chatId).last_proactive_at;
          const engagedHandles = new Set([
            ...decision.extracted.interested,
            ...Object.keys(decision.extracted.availability),
          ]);
          if (
            lastProactive &&
            recent.some(
              (row) => row.at > lastProactive && engagedHandles.has(row.handle),
            )
          )
            this.engaged(chatId);
          this.store.db
            .query(
              "INSERT INTO classifier_log(chat_id,at,input_rowids,output_json,spoke) VALUES (?,?,?,?,0)",
            )
            .run(
              chatId,
              this.now(),
              JSON.stringify(recent.map((row) => row.rowid)),
              JSON.stringify(decision),
            );
          this.store.db
            .query("UPDATE chats SET last_eval_rowid=? WHERE chat_id=?")
            .run(last.rowid, chatId);
          this.bursts.evaluated(chatId, version, decision);
          this.log({
            event: "classification",
            chat: chatId,
            mode: this.config.passiveMode,
            stage: decision.stage,
            confidence: decision.confidence,
            shouldSpeak: decision.should_speak,
            reason: decision.reason,
          });
        }
        const current = this.bursts.pending.get(chatId);
        if (
          !current ||
          current.version !== version ||
          this.now() - current.lastAt < this.config.debounceMs
        )
          return;
        this.bursts.pending.delete(chatId);
        if (!decision) return;
        ctx = this.context(chatId, last.handle, false, message);
        const observed = this.billing.observe(ctx, decision);
        if (
          observed &&
          this.config.passiveMode === "live" &&
          this.store.chat(chatId).quiet_until <= this.now()
        )
          this.queue(observed, true);
        const policy = speakingPolicy({
          chat: this.store.chat(chatId),
          decision,
          plan: ctx.plan,
          now: this.now(),
          lastMessageAt: current.lastAt,
          debounceMs: this.config.debounceMs,
          recentCount: recent.length,
          participantCount: ctx.participants.length,
        });
        if (policy.reason === "unanswered-backoff") this.quiet(ctx);
        this.log({
          event: "policy",
          chat: chatId,
          allow: policy.allow,
          reason: policy.reason,
          mode: this.config.passiveMode,
        });
        if (policy.allow && this.config.passiveMode === "live") {
          const queued = this.act(ctx, decision, true, policy.stageKey);
          if (queued)
            this.store.db
              .query(
                "UPDATE classifier_log SET spoke=1 WHERE id=(SELECT MAX(id) FROM classifier_log WHERE chat_id=?)",
              )
              .run(chatId);
        }
      } catch (error) {
        this.bursts.evaluated(chatId, version, null);
        if (
          this.bursts.pending.get(chatId)?.version === version &&
          this.now() - burst.lastAt >= this.config.debounceMs
        )
          this.bursts.pending.delete(chatId);
        this.logError(error, "passive", chatId);
      }
    });
  }

  tick(): void {
    if (this.stopped) return;
    const now = this.now();
    for (const chatId of this.bursts.due(
      now,
      this.config.debounceMs,
      this.config.burstSize,
    ))
      this.evaluate(chatId);
    if (now - this.lastScheduled >= 30_000) {
      this.lastScheduled = now;
      this.store.prune(now);
      for (const chatId of this.config.allowedChats) {
        if (this.forgetting.has(chatId)) continue;
        const ctx = this.context(chatId);
        if (
          ctx.plan?.stage === "gathering" &&
          now - ctx.plan.stageChangedAt >= 20 * 60_000
        ) {
          const evaluated =
            this.store.db
              .query<{ at: number }, [string]>(
                "SELECT MAX(at) AS at FROM classifier_log WHERE chat_id=?",
              )
              .get(chatId)?.at ?? 0;
          if (
            evaluated < ctx.plan.stageChangedAt + 20 * 60_000 &&
            !this.bursts.pending.has(chatId)
          )
            this.bursts.receive(chatId, now - this.config.debounceMs, true);
        }
        if (this.store.chat(chatId).quiet_until > now) continue;
        if (this.config.passiveMode === "live") {
          try {
            this.queue(this.planning.tick(ctx), true);
            this.queue(this.billing.tick(this.context(chatId)), true);
          } catch (error) {
            this.logError(error, "scheduler", chatId);
          }
        }
      }
    }
    if (!this.flushing) this.flushJob = this.flush();
  }

  private async flush(): Promise<void> {
    this.flushing = true;
    try {
      for (const row of this.store.pending()) {
        if (this.stopped) break;
        if (
          !this.config.allowedChats.has(row.chat_id) ||
          this.forgetting.has(row.chat_id)
        )
          continue;
        if (row.proactive || row.stage_key === "scheduled") {
          if (
            this.jobs.has(row.chat_id) ||
            this.store.chat(row.chat_id).quiet_until > this.now()
          )
            continue;
          const last = this.store.recent(row.chat_id).at(-1);
          if (last && this.now() - last.at < this.config.debounceMs) continue;
        }
        const tags = this.store.tags(row);
        if (
          tags.some((tag) =>
            tag.kind === "bill" || tag.kind === "bill_nudge"
              ? !this.billing.isDeliverable(tag, this.now(), tag.key)
              : !this.planning.isDeliverable(tag, this.now(), tag.key),
          )
        ) {
          this.store.db
            .query("UPDATE outbox SET status='cancelled' WHERE id=?")
            .run(row.id);
          continue;
        }
        if (
          tags.some(
            (tag) => tag.kind === "plan_reminder" || tag.kind === "bill_nudge",
          ) &&
          this.store.chat(row.chat_id).quiet_until > this.now()
        )
          continue;
        if (!this.store.canSend(row.chat_id, this.now())) continue;
        this.store.db
          .query(
            "UPDATE outbox SET status='sending' WHERE id=? AND status='queued'",
          )
          .run(row.id);
        try {
          await this.send(row.chat_id, row.text);
          this.store.sent(row, this.now());
          this.deliverTags(this.store.tags(row), undefined, this.now());
          this.log({ event: "sent", chat: row.chat_id, text: row.text });
        } catch (error) {
          this.store.db
            .query("UPDATE outbox SET status='failed',failure=? WHERE id=?")
            .run(
              error instanceof Error ? error.message : "Unknown send failure",
              row.id,
            );
          this.logError(error, "send", row.chat_id);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async idle(): Promise<void> {
    await Promise.all(this.jobs.values());
    await this.flushJob;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.bursts.pending.clear();
    await this.idle();
  }
}
