import { FusorClient } from "@spectrum-ts/core";
import z from "zod";
//#region src/space.d.ts
interface TelegramSpace {
  id: string;
}
//#endregion
//#region src/config.d.ts
declare const configSchema: z.ZodObject<{
  botToken: z.ZodString;
  webhookSecret: z.ZodOptional<z.ZodString>;
  baseUrl: z.ZodDefault<z.ZodURL>;
}, z.core.$strip>;
type TelegramConfig = z.infer<typeof configSchema>;
//#endregion
//#region src/index.d.ts
/**
 * Telegram provider for Spectrum.
 *
 * Inbound is delivered through Fusor: `createClient` returns a `fusor(...)`
 * client whose `verify` checks the Telegram webhook secret token and parses the
 * `Update` (pure parsing — no client). The `messages` handler reads `config`
 * from its ctx and builds a photon client inline only to download media bytes.
 * Outbound (`send`) also builds a photon client inline. Both go through
 * `@photon-ai/telegram-ts`. Drop `telegram.config({...})` into
 * `Spectrum({ providers: [...] })`.
 *
 * In cloud mode (`projectConfig` present), `createClient` also self-registers
 * the bot's webhook against the Fusor edge for the project slug — see
 * `ensureWebhook`. Without a slug (local/direct mode) registration is skipped.
 */
export declare const telegram: import("@spectrum-ts/core").Platform<import("@spectrum-ts/core").PlatformDef<"telegram", import("zod").ZodObject<{
  botToken: import("zod").ZodString;
  webhookSecret: import("zod").ZodOptional<import("zod").ZodString>;
  baseUrl: import("zod").ZodDefault<import("zod").ZodURL>;
}, import("zod/v4/core").$strip>, import("zod").ZodType<object, unknown, import("zod/v4/core").$ZodTypeInternals<object, unknown>> | undefined, import("zod").ZodType<object, unknown, import("zod/v4/core").$ZodTypeInternals<object, unknown>> | undefined, import("zod").ZodType<object, unknown, import("zod/v4/core").$ZodTypeInternals<object, unknown>> | undefined, FusorClient<import("@photon-ai/telegram-ts").Update>, {
  id: string;
}, TelegramSpace, undefined, import("@spectrum-ts/core").ProviderMessage<{
  id: string;
}, TelegramSpace, Record<never, never>>, undefined, Record<never, never>, Record<never, never>, Record<never, never>>> & Readonly<Record<never, never>>;
//#endregion
export type { TelegramConfig };