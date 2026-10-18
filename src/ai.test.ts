import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  BackboardAI,
  buildAiContext,
  parseClassification,
  parseDecision,
} from "./ai";
import type {
  AIConfig,
  ChatContext,
  ToolDefinition,
} from "./contracts";

const participants = [
  { handle: "alex", name: "Alex" },
  { handle: "jess", name: "Jess" },
];

function context(chatId = "chat-a"): ChatContext {
  return {
    chatId,
    now: Date.UTC(2026, 9, 18, 21, 5),
    tz: "America/Los_Angeles",
    botName: "amigo",
    actor: "alex",
    explicit: true,
    participants,
    recent: [
      {
        rowid: 1,
        id: "m1",
        handle: "alex",
        text: "Friday works",
        at: Date.UTC(2026, 9, 18, 20, 55),
      },
    ],
    plan: null,
    bills: null,
    message: {
      id: "m2",
      chatId,
      handle: "alex",
      text: "@amigo set it up",
      at: Date.UTC(2026, 9, 18, 21, 5),
      isFromMe: false,
      isGroup: true,
      kind: "text",
    },
  };
}

function validClassification(): Record<string, unknown> {
  return {
    is_planning: true,
    confidence: 0.92,
    stage: "gathering",
    should_speak: false,
    reason: "interest is being gathered",
    extracted: {
      interested: ["alex"],
      availability: {},
      time_options: [],
      place_options: [],
    },
  };
}

function messageResponse(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    message_id: "message-1",
    role: "assistant",
    content: "",
    status: "COMPLETED",
    thread_id: "thread-1",
    timestamp: new Date().toISOString(),
    ...fields,
  };
}

interface TestServer {
  readonly url: URL;
  stop(closeActiveConnections?: boolean): void;
}

interface MockState {
  mode:
    | "normal"
    | "invalid"
    | "bad-args"
    | "failed"
    | "forget-partial"
    | "forget-auth";
  requests: Array<{ path: string; body: Record<string, unknown> | null }>;
  deletedThreads: string[];
  deletedAssistants: string[];
  threadDeleteAttempts: Map<string, number>;
  memoryResetAttempts: Map<string, number>;
  server: TestServer;
}

function decisionFor(mode: MockState["mode"]): Record<string, unknown> {
  if (mode === "invalid") {
    return {
      ...validClassification(),
      action: { name: "unsupported_action", args: {} },
    };
  }
  if (mode === "bad-args") {
    return {
      ...validClassification(),
      action: {
        name: "create_poll",
        args: { question: "Which day?", options: "Friday" },
      },
    };
  }
  return {
    ...validClassification(),
    action: { name: "no_reply", args: {} },
  };
}

function startMock(mode: MockState["mode"] = "normal"): MockState {
  const state = {
    mode,
    requests: [],
    deletedThreads: [],
    deletedAssistants: [],
    threadDeleteAttempts: new Map<string, number>(),
    memoryResetAttempts: new Map<string, number>(),
  } as Omit<MockState, "server">;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body =
        request.method === "POST"
          ? ((await request.json()) as Record<string, unknown>)
          : null;
      state.requests.push({ path: url.pathname, body });

      if (
        request.method === "DELETE" &&
        url.pathname.startsWith("/api/threads/")
      ) {
        const threadId = url.pathname.slice("/api/threads/".length);
        state.deletedThreads.push(threadId);
        const attempts = (state.threadDeleteAttempts.get(threadId) ?? 0) + 1;
        state.threadDeleteAttempts.set(threadId, attempts);
        if (state.mode === "forget-auth") {
          return Response.json(
            { detail: "synthetic unauthorized" },
            { status: 401 },
          );
        }
        if (
          state.mode === "forget-partial" &&
          threadId === "planner-thread-1" &&
          attempts > 1
        ) {
          return Response.json(
            { detail: "resource already absent" },
            { status: 404 },
          );
        }
        return Response.json({});
      }
      if (
        request.method === "DELETE" &&
        url.pathname.startsWith("/api/assistants/") &&
        url.pathname.endsWith("/memories")
      ) {
        const assistantId = url.pathname.split("/")[3];
        const attempts = (state.memoryResetAttempts.get(assistantId) ?? 0) + 1;
        state.memoryResetAttempts.set(assistantId, attempts);
        if (
          state.mode === "forget-partial" &&
          assistantId === "planner-assistant-1" &&
          attempts === 1
        ) {
          return Response.json(
            { detail: "synthetic unavailable" },
            { status: 503 },
          );
        }
        return Response.json({});
      }
      if (
        request.method === "DELETE" &&
        url.pathname.startsWith("/api/assistants/")
      ) {
        const assistantId = url.pathname.slice("/api/assistants/".length);
        state.deletedAssistants.push(assistantId);
        return Response.json({});
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/threads/messages"
      ) {
        if (state.mode === "failed") {
          return Response.json(
            messageResponse({
              thread_id: "classifier-thread",
              status: "FAILED",
              content: "LLM Error: 503 UNAVAILABLE. provider overloaded",
            }),
          );
        }
        return Response.json(
          messageResponse({
            thread_id: "classifier-thread",
            content: JSON.stringify(decisionFor(state.mode)),
          }),
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return Object.assign(state, { server });
}

function config(baseUrl: string, classifierId = "classifier-id"): AIConfig {
  return {
    apiKey: "synthetic-key",
    provider: "model-router/v1",
    model: "planner-model",
    classifierProvider: "model-router/v1",
    classifierModel: "classifier-model",
    classifierId,
    botName: "amigo",
    baseUrl,
  };
}

const noReplyTool: ToolDefinition = {
  type: "function",
  function: {
    name: "no_reply",
    description: "Stay silent",
    parameters: { type: "object", properties: {}, required: [] },
  },
};

const pollTool: ToolDefinition = {
  type: "function",
  function: {
    name: "create_poll",
    description: "Open a poll",
    parameters: {
      type: "object",
      required: ["question", "options"],
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const testTools = [noReplyTool, pollTool];

/** Seeds per-chat rows the way earlier planner versions stored them. */
function seedLegacySessions(database: Database, chatIds: string[]): void {
  for (const [index, chatId] of chatIds.entries()) {
    database
      .query(
        "INSERT INTO ai_sessions (chat_id, assistant_id, thread_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
      )
      .run(
        chatId,
        `planner-assistant-${index + 1}`,
        `planner-thread-${index + 1}`,
      );
  }
}

async function settle(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) {
    await Bun.sleep(5);
  }
}

const openServers: MockState[] = [];
afterEach(() => {
  for (const state of openServers.splice(0)) {
    state.server.stop(true);
  }
});

describe("classifier boundary", () => {
  test("validates the schema and rejects unknown identities and model confirmation", () => {
    expect(
      parseClassification(JSON.stringify(validClassification()), participants)
        .stage,
    ).toBe("gathering");
    const unknown = validClassification();
    (unknown.extracted as Record<string, unknown>).interested = ["nobody"];
    expect(() =>
      parseClassification(JSON.stringify(unknown), participants),
    ).toThrow("unknown participant handle");
    const untrustedConfirmation = validClassification();
    (untrustedConfirmation.extracted as Record<string, unknown>).confirmed =
      true;
    expect(() =>
      parseClassification(JSON.stringify(untrustedConfirmation), participants),
    ).toThrow("required schema");
  });

  test("parses the decision action and treats a missing action as none", () => {
    expect(
      parseDecision(
        JSON.stringify(validClassification()),
        participants,
        testTools,
      ).action,
    ).toBeNull();
    const decision = parseDecision(
      JSON.stringify({
        ...validClassification(),
        action: {
          name: "create_poll",
          args: { question: "Which day?", options: ["Friday"] },
        },
      }),
      participants,
      testTools,
    );
    expect(decision.stage).toBe("gathering");
    expect(decision.action).toEqual({
      name: "create_poll",
      args: { question: "Which day?", options: ["Friday"] },
    });
  });

  test("builds bounded timezone-aware context", () => {
    const source = context();
    source.recent = Array.from({ length: 25 }, (_, index) => ({
      rowid: index,
      id: `message-${index}`,
      handle: "alex",
      text: `message ${index}`,
      at: source.now + index,
    }));
    source.lastEvaluatedRowid = 23;
    const rendered = buildAiContext(source);
    expect(rendered).toContain("timezone: America/Los_Angeles");
    expect(rendered).toContain("last_evaluated_rowid: 23");
    expect(rendered).toContain("explicit: true");
    expect(rendered).toContain("new_messages (since last evaluation):");
    expect(rendered).toContain("message 24");
    expect(rendered).not.toContain("message 0");
    expect(rendered).toContain("[new message] alex: @amigo set it up");
  });
});

describe("Backboard single-call decision", () => {
  test("classifies and picks an action in one stateless call", async () => {
    const mock = startMock();
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    const result = await ai.decide(context(), testTools);
    expect(result.stage).toBe("gathering");
    expect(result.action).toEqual({ name: "no_reply", args: {} });
    const calls = mock.requests.filter(
      (entry) => entry.path === "/api/threads/messages",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.memory).toBe("off");
    expect(String(calls[0].body?.content)).toContain("recent_messages");
    expect(JSON.stringify(calls[0].body)).toContain("Tool catalog");
    expect(
      mock.requests.some((entry) => entry.path.includes("tool-outputs")),
    ).toBe(false);
    await settle(() => mock.deletedThreads.length > 0);
    expect(mock.deletedThreads).toEqual(["classifier-thread"]);
    database.close();
  });

  test("rejects an unsupported tool action", async () => {
    const mock = startMock("invalid");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    await expect(ai.decide(context(), testTools)).rejects.toThrow(
      "unsupported tool unsupported_action",
    );
    database.close();
  });

  test("rejects tool arguments of the wrong type", async () => {
    const mock = startMock("bad-args");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    await expect(ai.decide(context(), testTools)).rejects.toThrow(
      "invalid argument type for options",
    );
    database.close();
  });

  test("keeps provider failure details", async () => {
    const mock = startMock("failed");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    await expect(ai.decide(context(), testTools)).rejects.toThrow(
      "503 UNAVAILABLE",
    );
    database.close();
  });

  test("forgets remote and local legacy chat state after remote deletion succeeds", async () => {
    const mock = startMock();
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    seedLegacySessions(database, ["chat-a"]);
    await ai.forget("chat-a");
    expect(mock.deletedThreads).toContain("planner-thread-1");
    expect(mock.deletedAssistants).toContain("planner-assistant-1");
    expect(
      database.query("SELECT COUNT(*) AS count FROM ai_sessions").get(),
    ).toEqual({
      count: 0,
    });
    database.close();
  });

  test("forget is a no-op for chats without legacy state", async () => {
    const mock = startMock();
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    await ai.forget("chat-a");
    expect(mock.requests).toEqual([]);
    database.close();
  });

  test("retries partial forget after restart and preserves another chat", async () => {
    const mock = startMock("forget-partial");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    seedLegacySessions(database, ["chat-a", "chat-b"]);

    await expect(ai.forget("chat-a")).rejects.toThrow("synthetic unavailable");
    expect(
      database.query("SELECT COUNT(*) AS count FROM ai_sessions").get(),
    ).toEqual({ count: 2 });

    const restartedInstance = new BackboardAI(
      database,
      config(`${mock.server.url}api`),
    );
    await restartedInstance.forget("chat-a");

    expect(
      mock.deletedThreads.filter((threadId) => threadId === "planner-thread-1"),
    ).toHaveLength(2);
    expect(mock.deletedThreads).not.toContain("planner-thread-2");
    expect(mock.deletedAssistants).toEqual(["planner-assistant-1"]);
    expect(
      database
        .query("SELECT chat_id, assistant_id, thread_id FROM ai_sessions")
        .all(),
    ).toEqual([
      {
        chat_id: "chat-b",
        assistant_id: "planner-assistant-2",
        thread_id: "planner-thread-2",
      },
    ]);
    database.close();
  });

  test("preserves local forget state after an authentication failure", async () => {
    const mock = startMock("forget-auth");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    seedLegacySessions(database, ["chat-a"]);

    await expect(ai.forget("chat-a")).rejects.toThrow("synthetic unauthorized");
    expect(
      database.query("SELECT COUNT(*) AS count FROM ai_sessions").get(),
    ).toEqual({
      count: 1,
    });
    expect(mock.deletedAssistants).toEqual([]);
    database.close();
  });
});
