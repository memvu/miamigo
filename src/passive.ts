import type { Classification, Decision, PlanSnapshot } from "./contracts";
import type { ChatState } from "./db";

const PLANNING =
  /\b(hang(?:out)?|hang out|food|dinner|lunch|brunch|breakfast|meet|weekend|bowling|movie|party|trip|plan|free (?:on|this)|available|fri(?:day)?|sat(?:urday)?|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|pho|kbbq)\b/i;
const BILL_WORD =
  /\b(bill|total|check|tab|came out to|split|owe|venmo|zelle)\b/i;
const AMOUNT = /\$?\d+(?:\.\d{1,2})?\b/;
const PAYMENT = /\b(paid|sent|venmo'?d|owe|tip)\b/i;
const VALUE_REASON =
  /stall|conflict|option|converg|waiting|majority|ready|agree|bill|expense|payment|tip|suggest|alternat|destinat|place|vegas|trip|where|change|pivot|switch|instead|start|kickoff|new plan|input|poll|participat|rally|initial|join|dinner|lunch|hang|food|party|meet|no.{0,30}(time|place|proposal)/i;

export function passesGate(
  text: string,
  activePlan: boolean,
  activeBill: boolean,
): boolean {
  return (
    activePlan ||
    PLANNING.test(text) ||
    (BILL_WORD.test(text) && AMOUNT.test(text)) ||
    (activeBill && PAYMENT.test(text))
  );
}

export function dayKey(now: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function speakingPolicy(input: {
  chat: ChatState;
  decision: Decision | Classification;
  plan: PlanSnapshot | null;
  now: number;
  lastMessageAt: number;
  debounceMs: number;
  recentCount?: number;
  participantCount?: number;
}): { allow: boolean; reason: string; stageKey: string; bill: boolean } {
  const { chat, decision, plan, now, lastMessageAt, debounceMs } = input;
  const bill =
    decision.bill?.is_shared_expense === true &&
    decision.bill.confidence >= 0.8;
  const stageKey = plan ? `${plan.id}:${plan.stage}` : "none";
  let reason = "allowed";

  if (chat.quiet_until > now) {
    reason = "quiet";
  } else if (now - lastMessageAt < debounceMs) {
    reason = "mid-burst";
  } else if (chat.unanswered_count >= 2) {
    reason = "unanswered-backoff";
  } else if (
    !bill &&
    (!decision.is_planning ||
      decision.confidence < 0.7 ||
      !decision.should_speak)
  ) {
    reason = "confidence-or-silence";
  } else if (
    !bill &&
    plan &&
    (plan.stage === "locked" ||
      plan.stage === "done" ||
      plan.stage === "cancelled")
  ) {
    reason = "silent-stage";
  } else if (
    !bill &&
    plan?.stage === "ready_to_lock" &&
    (!plan.location || !plan.startsAt)
  ) {
    reason = "incomplete-lock";
  }

  return { allow: reason === "allowed", reason, stageKey, bill };
}

export interface Burst {
  lastAt: number;
  version: number;
  evaluated: number;
  decision: Decision | null;
}

export class Bursts {
  readonly pending = new Map<string, Burst>();

  receive(chatId: string, now: number, gated: boolean): void {
    const current = this.pending.get(chatId);
    if (current) {
      current.lastAt = now;
      current.version += 1;
    } else if (gated) {
      this.pending.set(chatId, {
        lastAt: now,
        version: 1,
        evaluated: 0,
        decision: null,
      });
    }
  }

  due(now: number, debounceMs: number, burstSize: number): string[] {
    const ready: string[] = [];
    for (const [chatId, burst] of this.pending) {
      if (
        now - burst.lastAt >= debounceMs ||
        burst.version - burst.evaluated >= burstSize
      )
        ready.push(chatId);
    }
    return ready;
  }

  evaluated(
    chatId: string,
    version: number,
    decision: Decision | null,
  ): void {
    const current = this.pending.get(chatId);
    if (current) {
      current.evaluated = version;
      current.decision = decision;
    }
  }
}
