import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("a failed native send dispatches AppleScript once, without hidden retries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "miamigo-send-test-"));
  const bin = join(directory, "bin");
  const attempts = join(directory, "attempts.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "pgrep"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(
    join(bin, "osascript"),
    '#!/bin/sh\nprintf "attempt\\n" >> "$MIAMIGO_SEND_PROBE_LOG"\nprintf "Synthetic AppleScript failure\\n" >&2\nexit 1\n',
    { mode: 0o700 },
  );
  const script = `
    import { Database } from "bun:sqlite";
    import { IMessageSDK } from "@photon-ai/imessage-kit";
    const databasePath = process.env.MIAMIGO_SEND_PROBE_DB;
    const db = new Database(databasePath, { create: true });
    db.close();
    const sdk = new IMessageSDK({ databasePath, sendTimeout: 1000 });
    try {
      await sdk.send({ to: "+15555550123", text: "Synthetic sender regression" });
      process.exitCode = 1;
    } catch (error) {
      if (!error.message.includes("Synthetic AppleScript failure")) throw error;
    } finally {
      await sdk.close();
    }
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        MIAMIGO_SEND_PROBE_LOG: attempts,
        MIAMIGO_SEND_PROBE_DB: join(directory, "messages.db"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, errors] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(errors).toBe("");
    expect(exitCode).toBe(0);
    expect(await Bun.file(attempts).text()).toBe("attempt\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
