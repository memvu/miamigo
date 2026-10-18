import type { Database } from "bun:sqlite";
import {
  BackboardClient,
  BackboardNotFoundError,
  type ChatMessagesResponse,
} from "backboard-sdk";
import { z } from "zod";
import type {
  AIConfig,
  ChatContext,
  Classification,
  Decision,
  Stage,
  ToolDefinition,
  ToolIntent,
} from "./contracts";

// Enforced by withTimeout: the SDK's own timeout option is ignored by node-fetch v3.
const CALL_TIMEOUT_MS = 30_000;
const RECENT_MESSAGE_LIMIT = 20;
const STAGES = [
  "idea",
  "gathering",
  "choosing_time",
  "choosing_place",
  "ready_to_lock",
  "locked",
  "done",
  "cancelled",
] as const satisfies readonly Stage[];

const availabilitySchema = z
  .object({
    yes: z.array(z.string()),
    no: z.array(z.string()),
    maybe: z.array(z.string()),
  })
  .strict();

const extractedSchema = z
  .object({
    interested: z.array(z.string()),
    availability: z.record(z.string(), availabilitySchema),
    time_options: z.array(z.string()),
    place_options: z.array(z.string()),
    activity: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    title: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    location: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    starts_at: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    objection: z.boolean().optional(),
  })
  .strict();

const billSchema = z
  .object({
    is_shared_expense: z.boolean(),
    total: z.number().finite().nonnegative().nullable(),
    payer: z.string().nullable(),
    includes_tip: z.enum(["yes", "no", "unknown"]),
    split_hint: z.string().nullable(),
    confidence: z.number().finite().min(0).max(1),
    paid_by: z.array(z.string()),
    fixed_shares: z.record(z.string(), z.number().finite().nonnegative()),
  })
  .strict();

/** The runtime contract accepted from the classifier model. */
export const classifierSchema = z
  .object({
    is_planning: z.boolean(),
    confidence: z.number().finite().min(0).max(1),
    stage: z.enum(STAGES),
    should_speak: z.boolean(),
    reason: z.string().trim().min(1),
    extracted: extractedSchema,
    bill: billSchema.optional(),
  })
  .strict();

/** The classifier contract plus the one action the app should run locally. */
export const decisionSchema = classifierSchema
  .extend({
    action: z
      .object({
        name: z.string().trim().min(1),
        args: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .nullish()
      .transform((value) => value ?? null),
  })
  .strict();

const CLASSIFIER_SCHEMA_DESCRIPTION = `{
  "is_planning": boolean,
  "confidence": number from 0 to 1,
  "stage": "idea" | "gathering" | "choosing_time" | "choosing_place" | "ready_to_lock" | "locked" | "done" | "cancelled",
  "should_speak": boolean,
  "reason": "short non-empty explanation",
  "extracted": {
    "interested": ["participant handles"],
    "availability": {"participant handle": {"yes": ["options"], "no": ["options"], "maybe": ["options"]}},
    "time_options": ["options"],
    "place_options": ["options"],
    "activity": "optional activity" or null,
    "title": "optional title" or null,
    "location": "optional location" or null,
    "starts_at": "optional date/time text" or null,
    "objection": boolean
  },
  "bill": {
    "is_shared_expense": boolean,
    "total": number or null,
    "payer": "participant handle" or null,
    "includes_tip": "yes" | "no" | "unknown",
    "split_hint": "optional participant hint" or null,
    "confidence": number from 0 to 1,
    "paid_by": ["participant handles"],
    "fixed_shares": {"participant handle": number}
  },
  "action": {"name": "tool name from the tool catalog", "args": {tool arguments}} or null
}`;

/** Decider instructions include examples so short bursts are interpreted conservatively. */
const DECIDER_RULES = `You classify one conversation context from a group chat for Mi Amigo and choose the single action the app should take.
Return exactly one JSON object matching this schema and no Markdown:
${CLASSIFIER_SCHEMA_DESCRIPTION}
Use participant handles exactly as supplied in the context, never display names or invented identities.
Set should_speak false for ordinary banter, sarcasm, acknowledgements, or an active plan where participants are already conversing smoothly.
Set should_speak true when someone proposes, suggests, or asks for a plan (e.g. "plan dinner", "food this weekend", "let's hang"), or when there is a concrete stall, conflict, convergence, or high-confidence shared bill. Do not wait for other people to reply before speaking—help kick off the plan immediately and ask who wants to join so the suggestion doesn't get left on read.
Extract interest and availability even when should_speak is false. Never infer agreement from silence.
Use recent_messages as context only.
Choose action from the tool catalog below. The app is the source of truth and renders every reply with fixed templates, so never write user-facing text.
Use only participants, times, places, and amounts present in the context. Do not calculate money yourself.
Set action to null when no action is justified. Choose at most one action and keep its args valid for that tool's parameters.
When explicit is true, someone addressed the bot directly: choose the action that answers their request even if should_speak is false.
When someone suggests a plan (e.g. "Plan dinner", "let's hang"), choose create_poll asking who is joining, with title and what set when there is no active_plan (e.g. title: "Dinner", what: "dinner", question: "Who's in for dinner?", options: ["I'm in", "Can't make it"], closes_at: "tomorrow at 9pm").
Detect a new bill only in new_messages.
Set bill.paid_by and bill.fixed_shares from [new message] only.
Attribute each report to the sender shown in [new message].
Never use an older report from recent_messages or new_messages as the newest sender's report.
Few-shot examples:
1. Banter
Context: Alex: "lol that cat is huge"; Jess: "I know right"
Output: {"is_planning":false,"confidence":0.99,"stage":"idea","should_speak":false,"reason":"ordinary banter","extracted":{"interested":[],"availability":{},"time_options":[],"place_options":[]},"action":null}
2. Sarcastic non-plan
Context: Alex: "we should hang soon lol never"
Output: {"is_planning":false,"confidence":0.9,"stage":"idea","should_speak":false,"reason":"sarcastic suggestion with no commitment","extracted":{"interested":[],"availability":{},"time_options":[],"place_options":[]},"action":null}
3. Plan suggestion
Context: Alex: "Plan dinner"
Output: {"is_planning":true,"confidence":0.95,"stage":"gathering","should_speak":true,"reason":"new plan suggestion that needs group input and participation","extracted":{"interested":["alex"],"availability":{},"time_options":[],"place_options":[],"activity":"dinner","title":"Dinner"},"action":{"name":"create_poll","args":{"title":"Dinner","what":"dinner","question":"Who's in for dinner?","options":["I'm in","Can't make it"],"closes_at":"tomorrow at 9pm"}}}
4. Stalled planning
Context: Alex: "dinner this weekend?"; Jess: "yes"; Sam: "yes"; Linh: "what day"; Alex: "any day" (many recent messages, no proposal)
Output: {"is_planning":true,"confidence":0.91,"stage":"gathering","should_speak":true,"reason":"the group has interest but no concrete proposal after a stalled burst","extracted":{"interested":["alex","jess","sam"],"availability":{},"time_options":[],"place_options":[],"activity":"dinner"},"action":{"name":"ask_clarify","args":{"question":"Which day works for dinner this weekend?","options":["Saturday","Sunday"]}}}
5. Convergence
Output: {"is_planning":true,"confidence":0.94,"stage":"ready_to_lock","should_speak":true,"reason":"time and place have converged and need a lock proposal","extracted":{"interested":["alex","jess","sam","linh"],"availability":{"alex":{"yes":["Friday 7pm"],"no":[],"maybe":[]},"jess":{"yes":["Friday 7pm"],"no":[],"maybe":[]}},"time_options":["Friday 7pm"],"place_options":["Pho Bac"],"activity":"dinner"},"action":{"name":"finalize_plan","args":{"location":"Pho Bac","starts_at":"Friday 7pm","going":["alex","jess"]}}}`;

function toolCatalog(tools: ToolDefinition[]): string {
  return tools
    .map(
      (tool) =>
        `- ${tool.function.name}: ${tool.function.description} parameters=${JSON.stringify(tool.function.parameters)}`,
    )
    .join("\n");
}

/** One prompt covers classification and action choice, so each decision is a single call. */
export function deciderSystemPrompt(tools: ToolDefinition[]): string {
  return `${DECIDER_RULES}\nTool catalog:\n${toolCatalog(tools)}`;
}

interface AiSessionRow {
  chat_id: string;
  assistant_id: string;
  thread_id: string;
}

interface AssistantLike {
  assistantId?: string;
  assistant_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asChatResponse(value: unknown): ChatMessagesResponse {
  if (
    !isRecord(value) ||
    !("status" in value) ||
    !("content" in value) ||
    !("threadId" in value)
  ) {
    throw new Error("Backboard returned an unusable message response.");
  }
  return value as unknown as ChatMessagesResponse;
}

function responseFailure(response: ChatMessagesResponse): never {
  const detail =
    typeof response.content === "string" && response.content.trim()
      ? response.content.trim()
      : "The provider returned no failure details.";
  throw new Error(`Backboard generation failed: ${detail}`);
}

function requireCompleted(response: ChatMessagesResponse): void {
  if (response.status === "FAILED") {
    responseFailure(response);
  }
  if (
    response.status !== "COMPLETED" &&
    response.status !== "REQUIRES_ACTION"
  ) {
    throw new Error(
      `Backboard generation is not complete (status: ${response.status ?? "missing"}).`,
    );
  }
}

function formatNow(now: number, tz: string): string {
  try {
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(now));
    return `${local} (${tz}); unix_ms=${now}`;
  } catch {
    return `${new Date(now).toISOString()} (${tz}); unix_ms=${now}`;
  }
}

function jsonForPrompt(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "null";
  }
}

/** Build the bounded context block sent to either model. */
export function buildAiContext(ctx: ChatContext): string {
  const recent = ctx.recent.slice(-RECENT_MESSAGE_LIMIT);
  const cursor = ctx.lastEvaluatedRowid;
  const newMessages = recent.filter(
    (message) => cursor === undefined || message.rowid > cursor,
  );
  const recentLines = recent.map(
    (message) =>
      `- ${message.handle} @ ${new Date(message.at).toISOString()}: ${message.text}`,
  );
  const newMessageLines = newMessages.map(
    (message) =>
      `- ${message.handle} @ ${new Date(message.at).toISOString()}: ${message.text}`,
  );
  const lines = [
    "[context]",
    `now: ${formatNow(ctx.now, ctx.tz)}`,
    `timezone: ${ctx.tz}`,
    `last_evaluated_rowid: ${cursor ?? "none"}`,
    `bot_name: ${ctx.botName}`,
    `actor_handle: ${ctx.actor}`,
    `explicit: ${ctx.explicit}`,
    `participants: ${jsonForPrompt(
      ctx.participants.map((participant) => ({
        handle: participant.handle,
        name: participant.name,
      })),
    )}`,
    `active_plan: ${jsonForPrompt(ctx.plan)}`,
    `bills: ${jsonForPrompt(ctx.bills)}`,
    "recent_messages (last 20, context only):",
    ...recentLines,
    "new_messages (since last evaluation):",
    ...(newMessageLines.length > 0 ? newMessageLines : ["- none"]),
  ];
  if (ctx.message) {
    lines.push(`[new message] ${ctx.message.handle}: ${ctx.message.text}`);
  }
  return lines.join("\n");
}

function participantHandles(
  participants: ChatContext["participants"],
): Set<string> {
  return new Set(participants.map((participant) => participant.handle));
}

function ensureKnownHandle(
  value: string,
  known: Set<string>,
  path: string,
): void {
  if (!known.has(value)) {
    throw new Error(
      `Classifier returned unknown participant handle at ${path}.`,
    );
  }
}

function parseModelJson(content: string | null): unknown {
  if (content === null || !content.trim()) {
    throw new Error("Classifier returned no JSON content.");
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Classifier returned invalid JSON.");
  }
}

/** Parse and validate model JSON, including identity validation before domain actions. */
export function parseClassification(
  content: string | null,
  participants: ChatContext["participants"],
): Classification {
  const parsed = classifierSchema.safeParse(parseModelJson(content));
  if (!parsed.success) {
    throw new Error("Classifier JSON did not match the required schema.");
  }
  return checkIdentities(parsed.data as Classification, participants);
}

/** Parse the single-call decision: a classification plus at most one validated tool action. */
export function parseDecision(
  content: string | null,
  participants: ChatContext["participants"],
  tools: ToolDefinition[],
): Decision {
  const parsed = decisionSchema.safeParse(parseModelJson(content));
  if (!parsed.success) {
    throw new Error("Classifier JSON did not match the required schema.");
  }
  const { action, ...classification } = parsed.data;
  return {
    ...checkIdentities(classification as Classification, participants),
    action: action ? parseAction(action.name, action.args ?? {}, tools) : null,
  };
}

function checkIdentities(
  data: Classification,
  participants: ChatContext["participants"],
): Classification {
  const known = participantHandles(participants);
  for (const [index, handle] of data.extracted.interested.entries()) {
    ensureKnownHandle(handle, known, `extracted.interested[${index}]`);
  }
  for (const [handle, availability] of Object.entries(
    data.extracted.availability,
  )) {
    ensureKnownHandle(handle, known, "extracted.availability");
    for (const option of [
      ...availability.yes,
      ...availability.no,
      ...availability.maybe,
    ]) {
      if (!option.trim()) {
        throw new Error("Classifier returned an empty availability option.");
      }
    }
  }
  if (data.bill) {
    if (data.bill.payer) {
      ensureKnownHandle(data.bill.payer, known, "bill.payer");
    }
    for (const [index, handle] of data.bill.paid_by.entries()) {
      ensureKnownHandle(handle, known, `bill.paid_by[${index}]`);
    }
    for (const handle of Object.keys(data.bill.fixed_shares)) {
      ensureKnownHandle(handle, known, "bill.fixed_shares");
    }
  }
  return data;
}

function validateToolArguments(
  definition: ToolDefinition,
  args: unknown,
): Record<string, unknown> {
  if (!isRecord(args)) {
    throw new Error("Planner supplied non-object tool arguments.");
  }
  const parameters = definition.function.parameters;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter(
        (name): name is string => typeof name === "string",
      )
    : [];
  for (const name of required) {
    if (!(name in args)) {
      throw new Error(`Planner omitted required argument ${name}.`);
    }
  }
  const properties = isRecord(parameters.properties)
    ? parameters.properties
    : {};
  for (const [name, property] of Object.entries(properties)) {
    if (!(name in args) || !isRecord(property)) {
      continue;
    }
    const expectedType = property.type;
    const actual = args[name];
    const valid =
      expectedType === undefined ||
      (expectedType === "string" && typeof actual === "string") ||
      (expectedType === "number" &&
        typeof actual === "number" &&
        Number.isFinite(actual)) ||
      (expectedType === "integer" &&
        typeof actual === "number" &&
        Number.isInteger(actual)) ||
      (expectedType === "boolean" && typeof actual === "boolean") ||
      (expectedType === "array" && Array.isArray(actual)) ||
      (expectedType === "object" && isRecord(actual));
    if (!valid) {
      throw new Error(`Planner supplied invalid argument type for ${name}.`);
    }
  }
  return args;
}

function parseAction(
  name: string,
  args: unknown,
  tools: ToolDefinition[],
): ToolIntent {
  const definition = tools.find((tool) => tool.function.name === name);
  if (!definition) {
    throw new Error(`Planner requested unsupported tool ${name}.`);
  }
  return { name, args: validateToolArguments(definition, args) };
}

function assistantIdFrom(value: AssistantLike): string {
  const id = value.assistantId ?? value.assistant_id;
  if (!id) {
    throw new Error("Backboard returned no assistant ID.");
  }
  return id;
}

class CallTimeoutError extends Error {}

/** Rejects when a Backboard request stalls, so one stuck call cannot block a chat forever. */
function withTimeout<T>(
  operation: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CallTimeoutError(`Backboard ${label} timed out after ${ms}ms.`),
        ),
      ms,
    );
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function ignoreMissingRemoteResource(
  operation: Promise<unknown>,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof BackboardNotFoundError)) {
      throw error;
    }
  }
}

export class BackboardAI {
  private readonly client: BackboardClient;
  private readonly database: Database;
  private readonly config: AIConfig;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly timeoutMs: number;

  constructor(
    db: Database,
    config: AIConfig,
    log: (event: Record<string, unknown>) => void = () => undefined,
  ) {
    this.database = db;
    this.config = config;
    this.log = log;
    this.timeoutMs = config.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.client = new BackboardClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeout: CALL_TIMEOUT_MS,
    });
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        chat_id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    if (config.classifierId) {
      this.setSetting("classifier_id", config.classifierId);
    }
  }

  private setSetting(key: string, value: string): void {
    this.database
      .query(
        "INSERT INTO ai_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  private getSetting(key: string): string | undefined {
    const row = this.database
      .query<{ value: string }, [string]>(
        "SELECT value FROM ai_settings WHERE key = ?",
      )
      .get(key);
    return row?.value;
  }

  private requireClassifierId(): string {
    const id =
      this.config.classifierId?.trim() ||
      this.getSetting("classifier_id")?.trim();
    if (!id) {
      throw new Error(
        "BACKBOARD_CLASSIFIER_ID is required for classification.",
      );
    }
    return id;
  }

  private async llmCall<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    let status = "error";
    try {
      const result = await withTimeout(action(), this.timeoutMs, operation);
      if (isRecord(result) && "status" in result) {
        status = String(result.status ?? "unknown");
      } else {
        status = "completed";
      }
      return result;
    } catch (error) {
      if (error instanceof CallTimeoutError) status = "timeout";
      throw error;
    } finally {
      const event = {
        operation,
        status,
        duration_ms: Math.max(0, Date.now() - started),
      };
      try {
        this.log(event);
      } catch {
        // Logging must never replace a provider result or failure.
      }
    }
  }

  /** One stateless JSON call returns both the classification and the action to run. */
  async decide(ctx: ChatContext, tools: ToolDefinition[]): Promise<Decision> {
    const content = buildAiContext(ctx);
    const response = await this.llmCall("decider", async () =>
      asChatResponse(
        await this.client.sendMessage({
          assistantId: this.requireClassifierId(),
          systemPrompt: deciderSystemPrompt(tools),
          content,
          llm_provider: this.config.classifierProvider,
          model_name: this.config.classifierModel,
          stream: false,
          json_output: true,
          memory: "off",
        }),
      ),
    );
    // The thread is single-use; deleting it in the background keeps it off the reply path.
    if (response.threadId) {
      this.client.deleteThread(response.threadId).catch(() => undefined);
    }
    requireCompleted(response);
    if (response.status !== "COMPLETED") {
      throw new Error(
        `Classifier generation is not complete (status: ${response.status ?? "missing"}).`,
      );
    }
    if (response.toolCalls?.length) {
      throw new Error("Classifier unexpectedly requested a tool action.");
    }
    return parseDecision(response.content, ctx.participants, tools);
  }

  private getSession(chatId: string): AiSessionRow | null {
    return this.database
      .query<AiSessionRow, [string]>(
        "SELECT chat_id, assistant_id, thread_id FROM ai_sessions WHERE chat_id = ?",
      )
      .get(chatId);
  }

  /** Removes per-chat planner state left by earlier versions; a no-op otherwise. */
  async forget(chatId: string): Promise<void> {
    const session = this.getSession(chatId);
    if (!session) {
      return;
    }
    // A 404 is idempotent only for remote resources already absent. Other failures
    // leave the local session so a later invocation can retry the remaining steps.
    // /forget pauses the chat until this finishes, so each step is bounded too.
    await ignoreMissingRemoteResource(
      withTimeout(
        this.client.deleteThread(session.thread_id),
        this.timeoutMs,
        "deleteThread",
      ),
    );
    await ignoreMissingRemoteResource(
      withTimeout(
        this.client.resetMemories(session.assistant_id),
        this.timeoutMs,
        "resetMemories",
      ),
    );
    await ignoreMissingRemoteResource(
      withTimeout(
        this.client.deleteAssistant(session.assistant_id),
        this.timeoutMs,
        "deleteAssistant",
      ),
    );
    this.database
      .query("DELETE FROM ai_sessions WHERE chat_id = ?")
      .run(chatId);
  }
}

export async function createAssistants(
  config: AIConfig,
  tools: ToolDefinition[],
): Promise<{ classifierId: string }> {
  const client = new BackboardClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeout: CALL_TIMEOUT_MS,
  });
  const classifier = await client.createAssistant({
    name: "Mi Amigo decider",
    description:
      "Stateless JSON classifier that also picks one action per decision.",
    system_prompt: deciderSystemPrompt(tools),
    tools: [],
  });
  return { classifierId: assistantIdFrom(classifier) };
}

export const AI_LIMITS = {
  callTimeoutMs: CALL_TIMEOUT_MS,
  recentMessageLimit: RECENT_MESSAGE_LIMIT,
} as const;
