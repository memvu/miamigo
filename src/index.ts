import { BackboardAI } from "./ai";
import { Billing } from "./bills";
import { loadConfig } from "./config";
import { Core } from "./core";
import { Store } from "./db";
import { loadContacts, NativeIMessage } from "./imessage";
import { Planning } from "./planning";

function log(event: Record<string, unknown>): void {
  const prefix = event.event === "incoming" ? "iMessage" : "miamigo";
  process.stdout.write(`[${prefix}] ${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.allowedChats.size === 0)
    throw new Error(
      "Set ALLOWED_CHAT_IDS in .env. Use bun run list-chats to find group IDs.",
    );
  const checking = process.argv.includes("--check");
  if (!checking && !config.ai.classifierId) {
    throw new Error(
      "Run bun run setup to create the Backboard assistants before starting Mi Amigo.",
    );
  }
  const store = new Store(config.databasePath);
  let native: NativeIMessage | undefined;
  let core: Core | undefined;
  let interval: NodeJS.Timeout | undefined;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      clearInterval(interval);
      try {
        await core?.stop();
      } finally {
        try {
          await native?.close();
        } finally {
          store.close();
        }
      }
    })();
    return stopped;
  };
  const signal = (): void => {
    void stop().catch((error) => {
      log({
        event: "error",
        operation: "shutdown",
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    });
  };
  try {
    const planning = new Planning(store.db);
    const billing = new Billing(store.db);
    const ai = new BackboardAI(store.db, config.ai, log);
    native = new NativeIMessage(
      config,
      store,
      await loadContacts(config.contactsPath),
    );
    const transport = native;
    core = new Core(
      config,
      store,
      planning,
      billing,
      ai,
      (chatId, text) => transport.send(chatId, text),
      log,
    );
    const app = core;
    await native.start(
      (message) => {
        if (!checking) app.receive(message);
      },
      (error) =>
        log({
          event: "error",
          operation: "watcher",
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    process.stdout.write(
      `Listening in ${config.allowedChats.size} selected chat(s). Passive mode: ${config.passiveMode}. Incoming messages print below.\n`,
    );
    if (checking) {
      await stop();
      process.stdout.write(
        "Startup check passed. No messages were forwarded or sent.\n",
      );
      return;
    }
    process.once("SIGINT", signal);
    process.once("SIGTERM", signal);
    interval = setInterval(() => app.tick(), 1000);
  } catch (error) {
    await stop();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
