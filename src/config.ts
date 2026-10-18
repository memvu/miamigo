import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AIConfig } from "./contracts";

export interface Config {
  ai: AIConfig;
  allowedChats: Set<string>;
  botName: string;
  tz: string;
  passiveMode: "shadow" | "live";
  debounceMs: number;
  burstSize: number;
  databasePath: string;
  messagesDatabasePath: string;
  contactsPath: string;
  allowDMs: boolean;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Set ${key} in .env before starting Mi Amigo.`);
    return value;
  };
  const botName = env.BOT_NAME?.trim() || "amigo";
  const tz = env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat("en", { timeZone: tz }).format();
  const passiveMode = env.PASSIVE_MODE ?? "shadow";
  if (passiveMode !== "shadow" && passiveMode !== "live") {
    throw new Error("PASSIVE_MODE must be shadow or live.");
  }
  const debounceMs = Number(env.DEBOUNCE_MS ?? 45_000);
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 1) {
    throw new Error("DEBOUNCE_MS must be a positive integer in milliseconds.");
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const provider = required("BACKBOARD_LLM_PROVIDER");
  const model = required("BACKBOARD_MODEL");
  return {
    ai: {
      apiKey: required("BACKBOARD_API_KEY"),
      provider,
      model,
      classifierProvider: env.BACKBOARD_CLASSIFIER_PROVIDER?.trim() || provider,
      classifierModel: env.BACKBOARD_CLASSIFIER_MODEL?.trim() || model,
      classifierId: env.BACKBOARD_CLASSIFIER_ID?.trim() || undefined,
      plannerTemplateId: env.BACKBOARD_ASSISTANT_ID?.trim() || undefined,
      botName,
    },
    allowedChats: new Set(
      (env.ALLOWED_CHAT_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    botName,
    tz,
    passiveMode,
    debounceMs,
    burstSize: 8,
    databasePath: resolve(root, env.DATABASE_PATH || ".data/miamigo.db"),
    messagesDatabasePath:
      env.MESSAGES_DATABASE_PATH ||
      resolve(homedir(), "Library/Messages/chat.db"),
    contactsPath: resolve(root, env.CONTACTS_PATH || "contacts.json"),
    allowDMs: env.ALLOW_DMS === "true",
  };
}
