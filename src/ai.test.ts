import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { BackboardAI, buildAiContext, parseClassification } from "./ai";
import type {
  ActionResult,
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
    | "parallel"
    | "invalid"
    | "completed"
    | "failed"
    | "loop"
    | "forget-partial"
    | "forget-auth";
  requests: Array<{ path: string; body: Record<string, unknown> | null }>;
  plannerCalls: number;
  toolOutputSubmissions: number;
  createdAssistants: string[];
  createdThreads: Array<{ assistantId: string; threadId: string }>;
  deletedThreads: string[];
  deletedAssistants: string[];
  threadDeleteAttempts: Map<string, number>;
  memoryResetAttempts: Map<string, number>;
  server: TestServer;
}

function startMock(mode: MockState["mode"] = "normal"): MockState {
  const state = {
    mode,
    requests: [],
    plannerCalls: 0,
    toolOutputSubmissions: 0,
    createdAssistants: [],
    createdThreads: [],
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
        url.pathname === "/api/assistants/template-id/clone"
      ) {
        const assistantId = `planner-assistant-${state.createdAssistants.length + 1}`;
        state.createdAssistants.push(assistantId);
        return Response.json({
          assistant: {
            assistant_id: assistantId,
            name: "planner",
            tools: [],
            created_at: new Date().toISOString(),
          },
          documents_cloned: 0,
          memories_cloned: 0,
        });
      }
      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/assistants/") &&
        url.pathname.endsWith("/threads")
      ) {
        const assistantId = url.pathname.split("/")[3];
        const threadId = `planner-thread-${state.createdThreads.length + 1}`;
        state.createdThreads.push({ assistantId, threadId });
        return Response.json({
          thread_id: threadId,
          created_at: new Date().toISOString(),
          messages: [],
        });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/threads/tool-outputs"
      ) {
        state.toolOutputSubmissions += 1;
        if (state.mode === "loop") {
          return Response.json(
            messageResponse({
              thread_id: body?.thread_id,
              status: "REQUIRES_ACTION",
              tool_calls: [
                {
                  id: `call-${state.toolOutputSubmissions + 1}`,
                  type: "function",
                  function: { name: "no_reply", arguments: "{}" },
                },
              ],
            }),
          );
        }
        return Response.json(
          messageResponse({
            thread_id: body?.thread_id,
            content: "ignored final free text",
            status: "COMPLETED",
          }),
        );
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
        if (body?.assistant_id === "classifier-id") {
          return Response.json(
            messageResponse({
              thread_id: "classifier-thread",
              content: JSON.stringify(validClassification()),
            }),
          );
        }
        state.plannerCalls += 1;
        if (state.mode === "completed") {
          return Response.json(
            messageResponse({
              thread_id: body?.thread_id,
              content: "free-form planner response without a tool",
              status: "COMPLETED",
            }),
          );
        }
        const toolCalls =
          state.mode === "parallel"
            ? [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "no_reply", arguments: "{}" },
                },
                {
                  id: "call-2",
                  type: "function",
                  function: { name: "no_reply", arguments: "{}" },
                },
              ]
            : [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name:
                      state.mode === "invalid"
                        ? "unsupported_action"
                        : "no_reply",
                    arguments: "{}",
                  },
                },
              ];
        return Response.json(
          messageResponse({
            thread_id: body?.thread_id,
            content: "",
            status: "REQUIRES_ACTION",
            tool_calls: toolCalls,
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
    plannerTemplateId: "template-id",
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
    expect(rendered).toContain("new_messages (since last evaluation):");
    expect(rendered).toContain("message 24");
    expect(rendered).not.toContain("message 0");
    expect(rendered).toContain("[new message] alex: @amigo set it up");
  });
});

describe("Backboard state machine", () => {
  test("uses a short-lived classifier thread and preserves request context", async () => {
    const mock = startMock();
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    const result = await ai.classify(context());
    expect(result.stage).toBe("gathering");
    expect(mock.deletedThreads).toEqual(["classifier-thread"]);
    const request = mock.requests.find(
      (entry) => entry.path === "/api/threads/messages",
    );
    expect(request?.body?.memory).toBe("off");
    expect(String(request?.body?.content)).toContain("recent_messages");
    database.close();
  });

  test("isolates planner assistants and threads per chat and reuses them after restart", async () => {
    const mock = startMock();
    openServers.push(mock);
    const database = new Database(":memory:");
    const firstInstance = new BackboardAI(
      database,
      config(`${mock.server.url}api`),
    );
    const dispatches: string[] = [];
    const dispatch = async (intent: {
      name: string;
    }): Promise<ActionResult> => {
      dispatches.push(intent.name);
      return { emissions: [] };
    };
    for (const chatId of ["chat-a", "chat-b"]) {
      await firstInstance.plan(context(chatId), null, [noReplyTool], dispatch);
    }

    const restartedInstance = new BackboardAI(
      database,
      config(`${mock.server.url}api`),
    );
    for (const chatId of ["chat-a", "chat-b"]) {
      await restartedInstance.plan(
        context(chatId),
        null,
        [noReplyTool],
        dispatch,
      );
    }

    const plannerRequests = mock.requests.filter(
      (entry) =>
        entry.path === "/api/threads/messages" &&
        entry.body?.assistant_id !== "classifier-id",
    );
    expect(mock.createdAssistants).toEqual([
      "planner-assistant-1",
      "planner-assistant-2",
    ]);
    expect(mock.createdThreads).toEqual([
      { assistantId: "planner-assistant-1", threadId: "planner-thread-1" },
      { assistantId: "planner-assistant-2", threadId: "planner-thread-2" },
    ]);
    expect(
      plannerRequests.map((request) => request.body?.assistant_id),
    ).toEqual([
      "planner-assistant-1",
      "planner-assistant-2",
      "planner-assistant-1",
      "planner-assistant-2",
    ]);
    expect(plannerRequests.map((request) => request.body?.thread_id)).toEqual([
      "planner-thread-1",
      "planner-thread-2",
      "planner-thread-1",
      "planner-thread-2",
    ]);
    expect(
      plannerRequests.every((request) => request.body?.memory === "Auto"),
    ).toBe(true);
    expect(dispatches).toEqual([
      "no_reply",
      "no_reply",
      "no_reply",
      "no_reply",
    ]);
    expect(mock.toolOutputSubmissions).toBe(4);
    expect(
      database
        .query(
          "SELECT chat_id, assistant_id, thread_id FROM ai_sessions ORDER BY chat_id",
        )
        .all(),
    ).toEqual([
      {
        chat_id: "chat-a",
        assistant_id: "planner-assistant-1",
        thread_id: "planner-thread-1",
      },
      {
        chat_id: "chat-b",
        assistant_id: "planner-assistant-2",
        thread_id: "planner-thread-2",
      },
    ]);
    database.close();
  });

  test("rejects initial free-form completion without dispatching a tool", async () => {
    const mock = startMock("completed");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    let dispatches = 0;
    await expect(
      ai.plan(context(), null, [noReplyTool], async () => {
        dispatches += 1;
        return { emissions: [] };
      }),
    ).rejects.toThrow("without returning a tool result");
    expect(dispatches).toBe(0);
    expect(mock.toolOutputSubmissions).toBe(0);
    database.close();
  });

  test("rejects parallel tool calls before dispatch", async () => {
    const mock = startMock("parallel");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    let dispatches = 0;
    await expect(
      ai.plan(context(), null, [noReplyTool], async () => {
        dispatches += 1;
        return { emissions: [] };
      }),
    ).rejects.toThrow("exactly one tool");
    expect(dispatches).toBe(0);
    expect(mock.toolOutputSubmissions).toBe(0);
    database.close();
  });

  test("rejects unsupported tool calls before dispatch", async () => {
    const mock = startMock("invalid");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    let dispatches = 0;
    await expect(
      ai.plan(context(), null, [noReplyTool], async () => {
        dispatches += 1;
        return { emissions: [] };
      }),
    ).rejects.toThrow("unsupported tool");
    expect(dispatches).toBe(0);
    expect(mock.toolOutputSubmissions).toBe(0);
    database.close();
  });

  test("bounds repeated no_reply tool rounds", async () => {
    const mock = startMock("loop");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    let dispatches = 0;
    await expect(
      ai.plan(context(), null, [noReplyTool], async () => {
        dispatches += 1;
        return { emissions: [] };
      }),
    ).rejects.toThrow("4-round tool limit");
    expect(dispatches).toBe(4);
    expect(mock.toolOutputSubmissions).toBe(4);
    database.close();
  });

  test("keeps provider failure details", async () => {
    const mock = startMock("failed");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    await expect(ai.classify(context())).rejects.toThrow("503 UNAVAILABLE");
    database.close();
  });

  test("forgets remote and local chat state after remote deletion succeeds", async () => {
    const mock = startMock();
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    await ai.plan(context(), null, [noReplyTool], async () => ({
      emissions: [],
    }));
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

  test("retries partial forget after restart and preserves another chat", async () => {
    const mock = startMock("forget-partial");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    for (const chatId of ["chat-a", "chat-b"]) {
      await ai.plan(context(chatId), null, [noReplyTool], async () => ({
        emissions: [],
      }));
    }

    await expect(ai.forget("chat-a")).rejects.toThrow("synthetic unavailable");
    expect(
      database.query("SELECT COUNT(*) AS count FROM ai_sessions").get(),
    ).toEqual({ count: 2 });

    const restartedInstance = new BackboardAI(
      database,
      config(`${mock.server.url}api`),
    );
    await restartedInstance.forget("chat-a");
    await restartedInstance.plan(
      context("chat-b"),
      null,
      [noReplyTool],
      async () => ({
        emissions: [],
      }),
    );

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
    expect(mock.createdAssistants).toHaveLength(2);
    database.close();
  });

  test("preserves local forget state after an authentication failure", async () => {
    const mock = startMock("forget-auth");
    openServers.push(mock);
    const database = new Database(":memory:");
    const ai = new BackboardAI(database, config(`${mock.server.url}api`));
    await ai.plan(context(), null, [noReplyTool], async () => ({
      emissions: [],
    }));

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
