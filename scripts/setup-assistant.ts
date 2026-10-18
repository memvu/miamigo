import { join } from "node:path";
import { createAssistants } from "../src/ai";
import { loadConfig } from "../src/config";
import { tools } from "../src/tools";

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function replaceOrAppendEnvValue(
  content: string,
  key: string,
  value: string,
): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  return `${content}${separator}${line}\n`;
}

export function writeAssistantSettings(
  content: string,
  ids: { classifierId: string; plannerId: string },
): string {
  let next = replaceOrAppendEnvValue(
    content,
    "BACKBOARD_CLASSIFIER_ID",
    ids.classifierId,
  );
  next = replaceOrAppendEnvValue(next, "BACKBOARD_ASSISTANT_ID", ids.plannerId);
  return next;
}

export async function createAndSaveAssistantSettings(
  envPath: string,
  aiConfig: Parameters<typeof createAssistants>[0],
  create: typeof createAssistants = createAssistants,
): Promise<void> {
  let env: string;
  try {
    env = await Bun.file(envPath).text();
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    env = "";
  }

  const ids = await create(aiConfig, tools);
  await Bun.write(envPath, writeAssistantSettings(env, ids));
}

async function main(): Promise<void> {
  const loaded = loadConfig();
  const envPath = join(import.meta.dir, "..", ".env");
  await createAndSaveAssistantSettings(envPath, loaded.ai);
  process.stdout.write("Created classifier and planner assistant settings.\n");
}

if (import.meta.main) {
  await main();
}
