import type { Database } from "bun:sqlite";
import {
  BackboardClient,
  BackboardNotFoundError,
  type ChatMessagesResponse,
  type ToolCall,
} from "backboard-sdk";
import { z } from "zod";
import type {
  ActionResult,
  AIConfig,
  ChatContext,
  Classification,
  Stage,
  ToolDefinition,
  ToolIntent,
} from "./contracts";

const CALL_TIMEOUT_MS = 15_000;
const MAX_TOOL_ROUNDS = 4;
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
  }
}`;

/** Classifier instructions include examples so short bursts are interpreted conservatively. */
export const CLASSIFIER_SYSTEM_PROMPT = `You classify one conversation context from a group chat for Mi Amigo.
Return exactly one JSON object matching this schema and no Markdown:
${CLASSIFIER_SCHEMA_DESCRIPTION}
Use participant handles exactly as supplied in the context, never display names or invented identities.
Set should_speak false for ordinary banter, sarcasm, acknowledgements, or an active plan where participants are already conversing smoothly.
Set should_speak true when someone proposes, suggests, or asks for a plan (e.g. "plan dinner", "food this weekend", "let's hang"), or when there is a concrete stall, conflict, convergence, or high-confidence shared bill. Do not wait for other people to reply before speaking—help kick off the plan immediately and ask who wants to join so the suggestion doesn't get left on read.
Extract interest and availability even when should_speak is false. Never infer agreement from silence.
Use recent_messages as context only.
Detect a new bill only in new_messages.
Set bill.paid_by and bill.fixed_shares from [new message] only.
Attribute each report to the sender shown in [new message].
Never use an older report from recent_messages or new_messages as the newest sender's report.
Few-shot examples:
1. Banter
Context: Alex: "lol that cat is huge"; Jess: "I know right"
Output: {"is_planning":false,"confidence":0.99,"stage":"idea","should_speak":false,"reason":"ordinary banter","extracted":{"interested":[],"availability":{},"time_options":[],"place_options":[]}}
2. Sarcastic non-plan
Context: Alex: "we should hang soon lol never"
Output: {"is_planning":false,"confidence":0.9,"stage":"idea","should_speak":false,"reason":"sarcastic suggestion with no commitment","extracted":{"interested":[],"availability":{},"time_options":[],"place_options":[]}}
3. Plan suggestion
Context: Alex: "Plan dinner"
Output: {"is_planning":true,"confidence":0.95,"stage":"gathering","should_speak":true,"reason":"new plan suggestion that needs group input and participation","extracted":{"interested":["alex"],"availability":{},"time_options":[],"place_options":[],"activity":"dinner","title":"Dinner"}}
4. Stalled planning
Context: Alex: "dinner this weekend?"; Jess: "yes"; Sam: "yes"; Linh: "what day"; Alex: "any day" (many recent messages, no proposal)
Output: {"is_planning":true,"confidence":0.91,"stage":"gathering","should_speak":true,"reason":"the group has interest but no concrete proposal after a stalled burst","extracted":{"interested":["alex","jess","sam"],"availability":{},"time_options":[],"place_options":[],"activity":"dinner"}}
5. Convergence
Output: {"is_planning":true,"confidence":0.94,"stage":"ready_to_lock","should_speak":true,"reason":"time and place have converged and need a lock proposal","extracted":{"interested":["alex","jess","sam","linh"],"availability":{"alex":{"yes":["Friday 7pm"],"no":[],"maybe":[]},"jess":{"yes":["Friday 7pm"],"no":[],"maybe":[]}},"time_options":["Friday 7pm"],"place_options":["Pho Bac"],"activity":"dinner"}}`;

export const PLANNER_SYSTEM_PROMPT = `You are Mi Amigo's action planner for exactly one group chat.
The app is the source of truth and renders every reply with fixed templates. Never write a user-facing reply.
On your initial response, request exactly one tool call from the supplied tools. Never request multiple tools in one response.
Use only participants, times, places, and amounts present in the context or tool results. Do not calculate money yourself.
If no action is justified, call no_reply when that tool is available. Keep tool arguments valid JSON.
Take exactly one action per invocation. After a successful tool result, end the turn immediately without calling any more tools, including no_reply.
If a tool result explicitly reports a validation error, you may request ask_clarify once; otherwise stop after the action. Never use free-form text as a reply.
When someone suggests a plan (e.g. "Plan dinner", "let's hang"), call create_poll with a poll asking who is joining (e.g. question: "Who's in for dinner?", options: ["I'm in", "Can't make it"], closes_at: "tomorrow at 9pm").
Memory is enabled for this chat only; do not refer to facts from another chat.`;

interface AiSessionRow {
  chat_id: string;
  assistant_id: string;
  thread_id: string;
}

interface AssistantLike {
  assistantId?: string;
  assistant_id?: string;
}

interface ThreadLike {
  threadId?: string;
  thread_id?: string;
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

/** Parse and validate model JSON, including identity validation before domain actions. */
export function parseClassification(
  content: string | null,
  participants: ChatContext["participants"],
): Classification {
  if (content === null || !content.trim()) {
    throw new Error("Classifier returned no JSON content.");
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Classifier returned invalid JSON.");
  }
  const parsed = classifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Classifier JSON did not match the required schema.");
  }

  const known = participantHandles(participants);
  for (const [index, handle] of parsed.data.extracted.interested.entries()) {
    ensureKnownHandle(handle, known, `extracted.interested[${index}]`);
  }
  for (const [handle, availability] of Object.entries(
    parsed.data.extracted.availability,
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
  if (parsed.data.bill) {
    if (parsed.data.bill.payer) {
      ensureKnownHandle(parsed.data.bill.payer, known, "bill.payer");
    }
    for (const [index, handle] of parsed.data.bill.paid_by.entries()) {
      ensureKnownHandle(handle, known, `bill.paid_by[${index}]`);
    }
    for (const handle of Object.keys(parsed.data.bill.fixed_shares)) {
      ensureKnownHandle(handle, known, "bill.fixed_shares");
    }
  }
  return parsed.data as Classification;
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

function parseToolCall(call: ToolCall, tools: ToolDefinition[]): ToolIntent {
  if (call?.type !== "function" || typeof call.id !== "string" || !call.id) {
    throw new Error("Planner returned a malformed tool call.");
  }
  const functionCall = call.function;
  if (
    !functionCall ||
    typeof functionCall.name !== "string" ||
    !functionCall.name.trim()
  ) {
    throw new Error("Planner returned a tool call without a function name.");
  }
  const definition = tools.find(
    (tool) => tool.function.name === functionCall.name,
  );
  if (!definition) {
    throw new Error(`Planner requested unsupported tool ${functionCall.name}.`);
  }
  let args: unknown;
  if (typeof functionCall.arguments !== "string") {
    throw new Error("Planner returned missing tool arguments.");
  }
  try {
    args = JSON.parse(functionCall.arguments);
  } catch {
    throw new Error("Planner returned invalid tool arguments JSON.");
  }
  return {
    name: functionCall.name,
    args: validateToolArguments(definition, args),
  };
}

const STATE_MUTATING_TOOLS = new Set([
  "start_plan",
  "create_poll",
  "finalize_plan",
  "nudge",
  "schedule_reminder",
  "cancel_plan",
  "split_bill",
  "mark_paid",
  "adjust_share",
  "settle_bill",
  "forgive_share",
]);
const VALIDATION_ERROR_PATTERN =
  /\b(validation|invalid|ambiguous|unknown participant|required|missing)\b/i;

function isValidationErrorResult(result: ActionResult): boolean {
  if (!isRecord(result.data)) {
    return false;
  }
  if (
    result.data.validation_error === true ||
    result.data.validationError === true ||
    (result.data.ok === false && typeof result.data.error === "string")
  ) {
    return true;
  }
  return Object.values(result.data).some(
    (value) =>
      typeof value === "string" && VALIDATION_ERROR_PATTERN.test(value),
  );
}

function assistantIdFrom(value: AssistantLike): string {
  const id = value.assistantId ?? value.assistant_id;
  if (!id) {
    throw new Error("Backboard returned no assistant ID.");
  }
  return id;
}

function threadIdFrom(value: ThreadLike): string {
  const id = value.threadId ?? value.thread_id;
  if (!id) {
    throw new Error("Backboard returned no thread ID.");
  }
  return id;
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

  constructor(
    db: Database,
    config: AIConfig,
    log: (event: Record<string, unknown>) => void = () => undefined,
  ) {
    this.database = db;
    this.config = config;
    this.log = log;
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
    if (config.plannerTemplateId) {
      this.setSetting("planner_template_id", config.plannerTemplateId);
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

  private requirePlannerTemplateId(): string {
    const id =
      this.config.plannerTemplateId?.trim() ||
      this.getSetting("planner_template_id")?.trim();
    if (!id) {
      throw new Error("BACKBOARD_ASSISTANT_ID is required for planning.");
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
      const result = await action();
      if (isRecord(result) && "status" in result) {
        status = String(result.status ?? "unknown");
      } else {
        status = "completed";
      }
      return result;
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

  private async sendMessage(
    operation: string,
    options: Parameters<BackboardClient["sendMessage"]>[0],
  ): Promise<ChatMessagesResponse> {
    const response = await this.llmCall(operation, async () =>
      asChatResponse(await this.client.sendMessage(options)),
    );
    requireCompleted(response);
    return response;
  }

  private async submitToolOutputs(
    options: Parameters<BackboardClient["submitToolOutputsSimple"]>[0],
  ): Promise<ChatMessagesResponse> {
    const response = await this.llmCall("planner_tool_outputs", async () =>
      asChatResponse(await this.client.submitToolOutputsSimple(options)),
    );
    requireCompleted(response);
    return response;
  }

  async classify(ctx: ChatContext): Promise<Classification> {
    const content = buildAiContext(ctx);
    const response = await this.llmCall("classifier", async () =>
      asChatResponse(
        await this.client.sendMessage({
          assistantId: this.requireClassifierId(),
          systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
          content,
          llm_provider: this.config.classifierProvider,
          model_name: this.config.classifierModel,
          stream: false,
          json_output: true,
          memory: "off",
        }),
      ),
    );
    const threadId = response.threadId;
    let classification: Classification;
    try {
      requireCompleted(response);
      if (response.status !== "COMPLETED") {
        throw new Error(
          `Classifier generation is not complete (status: ${response.status ?? "missing"}).`,
        );
      }
      if (response.toolCalls?.length) {
        throw new Error("Classifier unexpectedly requested a tool action.");
      }
      classification = parseClassification(response.content, ctx.participants);
    } catch (error) {
      if (threadId) {
        try {
          await this.client.deleteThread(threadId);
        } catch {
          // Keep the generation or validation error as the primary failure.
        }
      }
      throw error;
    }
    if (threadId) await this.client.deleteThread(threadId);
    return classification;
  }

  private getSession(chatId: string): AiSessionRow | null {
    return this.database
      .query<AiSessionRow, [string]>(
        "SELECT chat_id, assistant_id, thread_id FROM ai_sessions WHERE chat_id = ?",
      )
      .get(chatId);
  }

  private async createPlannerSession(
    chatId: string,
    now: number,
  ): Promise<AiSessionRow> {
    const templateId = this.requirePlannerTemplateId();
    let assistantId: string | undefined;
    try {
      const clone = await this.client.cloneAssistant(templateId, {
        name: `Mi Amigo planner ${chatId.slice(0, 32)}`,
        copy_documents: false,
        copy_memories: false,
      });
      assistantId = assistantIdFrom(clone.assistant);
      const thread = await this.client.createThread(assistantId);
      const threadId = threadIdFrom(thread);
      this.database
        .query(
          "INSERT INTO ai_sessions (chat_id, assistant_id, thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(chatId, assistantId, threadId, now, now);
      return {
        chat_id: chatId,
        assistant_id: assistantId,
        thread_id: threadId,
      };
    } catch (error) {
      if (assistantId) {
        await this.client.deleteAssistant(assistantId).catch(() => undefined);
      }
      throw error;
    }
  }

  private async plannerSession(ctx: ChatContext): Promise<AiSessionRow> {
    const existing = this.getSession(ctx.chatId);
    if (existing) {
      return existing;
    }
    return this.createPlannerSession(ctx.chatId, ctx.now);
  }

  async plan(
    ctx: ChatContext,
    classification: Classification | null,
    tools: ToolDefinition[],
    dispatch: (intent: ToolIntent) => Promise<ActionResult>,
  ): Promise<void> {
    if (tools.length === 0) {
      throw new Error("Planner requires at least one tool definition.");
    }
    const session = await this.plannerSession(ctx);
    const classificationBlock = classification
      ? `\n[classification]\n${jsonForPrompt(classification)}`
      : "\n[classification]\nnull (explicit request; inspect the context)";
    let response = await this.sendMessage("planner", {
      assistantId: session.assistant_id,
      threadId: session.thread_id,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      content: `${buildAiContext(ctx)}${classificationBlock}`,
      llm_provider: this.config.provider,
      model_name: this.config.model,
      stream: false,
      memory: "Auto",
      tools,
    });

    let hasToolResult = false;
    let successfulMutation = false;
    let validationError = false;
    for (let round = 0; ; round += 1) {
      if (response.status === "COMPLETED") {
        if (!hasToolResult) {
          throw new Error("Planner completed without returning a tool result.");
        }
        // The application deliberately ignores final free-form text only after tool use.
        return;
      }
      if (response.status !== "REQUIRES_ACTION") {
        requireCompleted(response);
        throw new Error(
          `Planner generation is not actionable (status: ${response.status ?? "missing"}).`,
        );
      }
      if (round >= MAX_TOOL_ROUNDS) {
        throw new Error(
          `Planner exceeded the ${MAX_TOOL_ROUNDS}-round tool limit.`,
        );
      }
      const calls = response.toolCalls;
      if (calls?.length !== 1) {
        throw new Error("Planner must request exactly one tool at a time.");
      }
      const intent = parseToolCall(calls[0], tools);
      if (
        hasToolResult &&
        validationError &&
        intent.name !== "ask_clarify" &&
        intent.name !== "no_reply"
      ) {
        throw new Error(
          "Only ask_clarify or no_reply may follow a validation-error tool result.",
        );
      }
      if (hasToolResult && intent.name === "ask_clarify" && !validationError) {
        throw new Error("ask_clarify requires a validation-error tool result.");
      }
      if (successfulMutation && intent.name !== "no_reply") {
        throw new Error(
          "After a successful state-mutating tool, planner may only call no_reply.",
        );
      }
      const result = await dispatch(intent);
      validationError = isValidationErrorResult(result);
      if (STATE_MUTATING_TOOLS.has(intent.name) && !validationError) {
        successfulMutation = true;
      }
      hasToolResult = true;
      const output = JSON.stringify(result);
      if (output === undefined) {
        throw new Error("Tool dispatch returned an unserializable result.");
      }
      response = await this.submitToolOutputs({
        threadId: session.thread_id,
        toolOutputs: [
          {
            tool_call_id: calls[0].id,
            output,
          },
        ],
      });
      this.database
        .query("UPDATE ai_sessions SET updated_at = ? WHERE chat_id = ?")
        .run(ctx.now, ctx.chatId);
    }
  }

  async forget(chatId: string): Promise<void> {
    const session = this.getSession(chatId);
    if (!session) {
      return;
    }
    // A 404 is idempotent only for remote resources already absent. Other failures
    // leave the local session so a later invocation can retry the remaining steps.
    await ignoreMissingRemoteResource(
      this.client.deleteThread(session.thread_id),
    );
    await ignoreMissingRemoteResource(
      this.client.resetMemories(session.assistant_id),
    );
    await ignoreMissingRemoteResource(
      this.client.deleteAssistant(session.assistant_id),
    );
    this.database
      .query("DELETE FROM ai_sessions WHERE chat_id = ?")
      .run(chatId);
  }
}

export async function createAssistants(
  config: AIConfig,
  tools: ToolDefinition[],
): Promise<{ classifierId: string; plannerId: string }> {
  const client = new BackboardClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeout: CALL_TIMEOUT_MS,
  });
  const classifier = await client.createAssistant({
    name: "Mi Amigo classifier",
    description: "Stateless JSON classifier for gated group-chat bursts.",
    system_prompt: CLASSIFIER_SYSTEM_PROMPT,
    tools: [],
  });
  try {
    const planner = await client.createAssistant({
      name: "Mi Amigo planner template",
      description:
        "Planner template cloned into one isolated assistant per chat.",
      system_prompt: PLANNER_SYSTEM_PROMPT,
      tools,
    });
    return {
      classifierId: assistantIdFrom(classifier),
      plannerId: assistantIdFrom(planner),
    };
  } catch (error) {
    await client
      .deleteAssistant(assistantIdFrom(classifier))
      .catch(() => undefined);
    throw error;
  }
}

export const AI_LIMITS = {
  callTimeoutMs: CALL_TIMEOUT_MS,
  maxToolRounds: MAX_TOOL_ROUNDS,
  recentMessageLimit: RECENT_MESSAGE_LIMIT,
} as const;
