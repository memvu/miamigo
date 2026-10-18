import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIConfig } from "../src/contracts";
import { createAndSaveAssistantSettings } from "./setup-assistant";

const syntheticConfig: AIConfig = {
  apiKey: "synthetic-api-key",
  provider: "synthetic-provider",
  model: "synthetic-model",
  classifierProvider: "synthetic-provider",
  classifierModel: "synthetic-classifier",
  botName: "amigo",
};

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "miamigo-assistant-setup-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reads and preserves existing environment settings before creating assistants", async () => {
  await withTempDirectory(async (directory) => {
    const envPath = join(directory, ".env");
    const original = [
      "BACKBOARD_API_KEY=synthetic-api-key",
      "BACKBOARD_MODEL=synthetic-model",
      "CUSTOM_SETTING=preserve-me",
      "BACKBOARD_CLASSIFIER_ID=old-classifier",
      "BACKBOARD_ASSISTANT_ID=old-planner",
    ].join("\n");
    await writeFile(envPath, original);

    let called = false;
    await createAndSaveAssistantSettings(envPath, syntheticConfig, async () => {
      called = true;
      expect(await readFile(envPath, "utf8")).toBe(original);
      return { classifierId: "new-classifier", plannerId: "new-planner" };
    });

    expect(called).toBe(true);
    expect(await readFile(envPath, "utf8")).toBe(
      [
        "BACKBOARD_API_KEY=synthetic-api-key",
        "BACKBOARD_MODEL=synthetic-model",
        "CUSTOM_SETTING=preserve-me",
        "BACKBOARD_CLASSIFIER_ID=new-classifier",
        "BACKBOARD_ASSISTANT_ID=new-planner",
      ].join("\n"),
    );
  });
});

test("creates settings when the environment file is absent", async () => {
  await withTempDirectory(async (directory) => {
    const envPath = join(directory, ".env");
    await createAndSaveAssistantSettings(
      envPath,
      syntheticConfig,
      async () => ({
        classifierId: "new-classifier",
        plannerId: "new-planner",
      }),
    );

    expect(await readFile(envPath, "utf8")).toBe(
      "BACKBOARD_CLASSIFIER_ID=new-classifier\nBACKBOARD_ASSISTANT_ID=new-planner\n",
    );
  });
});

test("does not create remote assistants or overwrite a path that cannot be read", async () => {
  await withTempDirectory(async (directory) => {
    let called = false;
    await expect(
      createAndSaveAssistantSettings(directory, syntheticConfig, async () => {
        called = true;
        return { classifierId: "new-classifier", plannerId: "new-planner" };
      }),
    ).rejects.toBeTruthy();
    expect(called).toBe(false);
  });
});
