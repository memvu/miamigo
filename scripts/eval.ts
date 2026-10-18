import { Database } from "bun:sqlite";
import { BackboardAI } from "../src/ai";
import { loadConfig } from "../src/config";
import type { ChatContext } from "../src/contracts";
import { tools } from "../src/tools";

const participants = [
  { handle: "alex", name: "Alex" },
  { handle: "jess", name: "Jess" },
  { handle: "sam", name: "Sam" },
  { handle: "linh", name: "Linh" },
];

interface Fixture {
  name: string;
  expectedSpeak: boolean;
  messages: string[];
  durationMinutes?: number;
}

const fixtures: Fixture[] = [
  {
    name: "banter-1",
    expectedSpeak: false,
    messages: ["that cat is huge", "lol, it takes up the whole couch"],
  },
  {
    name: "banter-2",
    expectedSpeak: false,
    messages: ["what a game last night", "that ending was wild"],
  },
  {
    name: "banter-3",
    expectedSpeak: false,
    messages: [
      "we should hang soon lol never",
      "true, our calendars are undefeated",
    ],
  },
  {
    name: "banter-4",
    expectedSpeak: false,
    messages: ["look at this meme", "that is exactly how finals week feels"],
  },
  {
    name: "sarcasm-1",
    expectedSpeak: false,
    messages: [
      "we should hang soon",
      "absolutely, at 3am on the moon, very doable",
      "perfect, I'll bring the space snacks",
    ],
  },
  {
    name: "fresh-plan-1",
    expectedSpeak: false,
    messages: ["anyone down for dinner this weekend?"],
  },
  {
    name: "fresh-plan-2",
    expectedSpeak: false,
    messages: ["we should get food sometime", "maybe, that sounds good"],
  },
  {
    name: "fresh-plan-3",
    expectedSpeak: false,
    messages: ["movie night?", "I'm interested"],
  },
  {
    name: "stalled-1",
    expectedSpeak: true,
    durationMinutes: 25,
    messages: [
      "anyone want dinner this weekend?",
      "yeah, I'm in",
      "same here",
      "what day works?",
      "Saturday could work",
      "what time?",
      "after 6 is good",
      "where should we go?",
      "not sure yet",
      "someone pick a day and place",
    ],
  },
  {
    name: "stalled-2",
    expectedSpeak: true,
    durationMinutes: 25,
    messages: [
      "we keep saying brunch",
      "I'm in",
      "same",
      "Saturday?",
      "maybe",
      "Sunday?",
      "not sure",
      "what time?",
      "whenever works",
      "can someone choose a date?",
    ],
  },
  {
    name: "stalled-3",
    expectedSpeak: true,
    durationMinutes: 25,
    messages: [
      "should we meet Friday?",
      "Friday might work",
      "Saturday?",
      "also possible",
      "Sunday?",
      "not sure",
      "Friday or Saturday?",
      "either, I guess",
      "we still have no date",
      "someone choose one",
    ],
  },
  {
    name: "convergence-1",
    expectedSpeak: true,
    messages: ["Friday at 7 at Pho Bac?", "yes", "bet", "works"],
  },
  {
    name: "convergence-2",
    expectedSpeak: true,
    messages: ["Saturday 6pm, KBBQ", "works for me", "same"],
  },
  {
    name: "bill-1",
    expectedSpeak: true,
    messages: ["bill was $50 total, I paid"],
  },
  {
    name: "bill-2",
    expectedSpeak: false,
    messages: ["this jacket was $50"],
  },
];

function contextFor(fixture: Fixture, index: number): ChatContext {
  const base = Date.UTC(2026, 9, 18, 14, 5) + index * 60_000;
  const durationMs =
    (fixture.durationMinutes ?? (fixture.messages.length - 1) * 0.5) * 60_000;
  const intervalMs =
    fixture.messages.length > 1
      ? durationMs / (fixture.messages.length - 1)
      : 0;
  const recent = fixture.messages.map((text, messageIndex) => ({
    rowid: messageIndex + 1,
    id: `${fixture.name}-${messageIndex}`,
    handle: participants[messageIndex % participants.length].handle,
    text,
    at: base - durationMs + messageIndex * intervalMs,
  }));
  const newest = recent[recent.length - 1];
  return {
    chatId: "synthetic-eval-chat",
    now: base,
    tz: "America/Los_Angeles",
    botName: "amigo",
    actor: newest.handle,
    explicit: false,
    participants,
    recent,
    plan: null,
    bills: null,
    message: {
      id: newest.id,
      chatId: "synthetic-eval-chat",
      handle: newest.handle,
      text: newest.text,
      at: newest.at,
      isFromMe: false,
      isGroup: true,
      kind: "text",
    },
  };
}

async function main(): Promise<void> {
  const config = (await loadConfig()).ai;
  const database = new Database(":memory:");
  const ai = new BackboardAI(database, config);
  const outcomes: Array<Record<string, unknown>> = [];
  try {
    for (const [index, fixture] of fixtures.entries()) {
      try {
        const classification = await ai.decide(
          contextFor(fixture, index),
          tools,
        );
        outcomes.push({
          name: fixture.name,
          expectedSpeak: fixture.expectedSpeak,
          shouldSpeak: classification.should_speak,
          confidence: classification.confidence,
          stage: classification.stage,
          action: classification.action?.name ?? null,
          falseSpeak: !fixture.expectedSpeak && classification.should_speak,
          falseSilent: fixture.expectedSpeak && !classification.should_speak,
        });
      } catch (error) {
        outcomes.push({
          name: fixture.name,
          expectedSpeak: fixture.expectedSpeak,
          error:
            error instanceof Error ? error.message : "unknown classifier error",
        });
      }
    }
  } finally {
    database.close();
  }
  const falseSpeak = outcomes.filter(
    (outcome) => outcome.falseSpeak === true,
  ).length;
  const falseSilent = outcomes.filter(
    (outcome) => outcome.falseSilent === true,
  ).length;
  process.stdout.write(
    `${JSON.stringify(
      {
        syntheticCases: fixtures.length,
        falseSpeak,
        falseSilent,
        outcomes,
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  await main();
}
