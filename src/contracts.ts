export type Stage =
  | "idea"
  | "gathering"
  | "choosing_time"
  | "choosing_place"
  | "ready_to_lock"
  | "locked"
  | "done"
  | "cancelled";

export interface Participant {
  handle: string;
  name: string;
  venmo?: string;
  zelle?: string;
}

export interface IncomingMessage {
  id: string;
  chatId: string;
  handle: string;
  text: string;
  at: number;
  isFromMe: boolean;
  isGroup: boolean;
  kind: string;
  replyTo?: string;
  reaction?: { targetId: string; emoji: string; removed: boolean };
}

export interface BufferedMessage {
  rowid: number;
  id: string;
  handle: string;
  text: string;
  at: number;
}

export interface PlanSnapshot {
  id: number;
  title: string;
  what: string;
  location: string | null;
  startsAt: number | null;
  stage: Stage;
  going: string[];
  interested: string[];
  timeOptions: string[];
  placeOptions: string[];
  availability: Record<
    string,
    { yes: string[]; no: string[]; maybe: string[] }
  >;
  proposedAt: number | null;
  lockedAt: number | null;
  stageChangedAt: number;
  openPoll?: {
    id: number;
    question: string;
    options: string[];
    voted: string[];
  };
}

export interface Classification {
  is_planning: boolean;
  confidence: number;
  stage: Stage;
  should_speak: boolean;
  reason: string;
  extracted: {
    interested: string[];
    availability: Record<
      string,
      { yes: string[]; no: string[]; maybe: string[] }
    >;
    time_options: string[];
    place_options: string[];
    activity?: string;
    title?: string;
    location?: string;
    starts_at?: string;
    objection?: boolean;
  };
  bill?: {
    is_shared_expense: boolean;
    total: number | null;
    payer: string | null;
    includes_tip: "yes" | "no" | "unknown";
    split_hint: string | null;
    confidence: number;
    paid_by: string[];
    fixed_shares: Record<string, number>;
  };
}

/** One model decision: the classification plus the single action to run locally. */
export interface Decision extends Classification {
  action: ToolIntent | null;
}

export interface ChatContext {
  chatId: string;
  now: number;
  tz: string;
  botName: string;
  actor: string;
  explicit: boolean;
  participants: Participant[];
  recent: BufferedMessage[];
  lastEvaluatedRowid?: number;
  plan: PlanSnapshot | null;
  bills: unknown;
  message?: IncomingMessage;
}

export interface DeliveryTag {
  kind: "poll" | "lock" | "plan_reminder" | "bill" | "bill_nudge";
  id: number;
  key?: string;
}

export interface Emission {
  chatId: string;
  text: string;
  key: string;
  tag?: DeliveryTag;
}

export interface ActionResult {
  emissions: Emission[];
  data?: unknown;
}

export interface ToolIntent {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AIConfig {
  apiKey: string;
  provider: string;
  model: string;
  classifierProvider: string;
  classifierModel: string;
  classifierId?: string;
  callTimeoutMs?: number;
  botName: string;
  baseUrl?: string;
}
