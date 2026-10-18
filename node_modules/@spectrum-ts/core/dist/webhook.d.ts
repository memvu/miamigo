import z from "zod";
//#region src/webhook/types.d.ts
/**
 * Wire schemas for the **native Spectrum webhook**
 * (https://photon.codes/docs/webhooks).
 *
 * Unlike the fusor webhook — which relays a raw provider request inside a
 * protobuf envelope — the native webhook delivers Spectrum's own message model
 * already normalized to slim JSON (methods and byte payloads stripped), signed
 * with an HMAC. These schemas validate the fields the deserializer depends on
 * while **preserving** unknown/extra fields (`z.looseObject`), so additive
 * changes — new platform-specific space fields, future content arms — never
 * break an older SDK. Content is discriminated by hand in `deserialize.ts`
 * rather than here, so an unknown content `type` survives parsing instead of
 * throwing.
 */
export declare const slimSenderSchema: z.ZodObject<{
  id: z.ZodString;
  platform: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const slimSpaceSchema: z.ZodObject<{
  id: z.ZodString;
  platform: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const slimContentSchema: z.ZodObject<{
  type: z.ZodString;
}, z.core.$loose>;
/** A slim reference to another message — e.g. a reaction's `target`. */
export declare const slimMessageRefSchema: z.ZodObject<{
  id: z.ZodString;
  platform: z.ZodOptional<z.ZodString>;
  timestamp: z.ZodOptional<z.ZodString>;
  sender: z.ZodOptional<z.ZodObject<{
    id: z.ZodString;
    platform: z.ZodOptional<z.ZodString>;
  }, z.core.$loose>>;
  contentPreview: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export declare const slimMessageSchema: z.ZodObject<{
  id: z.ZodString;
  platform: z.ZodOptional<z.ZodString>;
  direction: z.ZodOptional<z.ZodString>;
  timestamp: z.ZodOptional<z.ZodString>;
  sender: z.ZodOptional<z.ZodObject<{
    id: z.ZodString;
    platform: z.ZodOptional<z.ZodString>;
  }, z.core.$loose>>;
  space: z.ZodObject<{
    id: z.ZodString;
    platform: z.ZodOptional<z.ZodString>;
  }, z.core.$loose>;
  content: z.ZodObject<{
    type: z.ZodString;
  }, z.core.$loose>;
}, z.core.$loose>;
export declare const slimEnvelopeSchema: z.ZodObject<{
  event: z.ZodString;
  space: z.ZodOptional<z.ZodObject<{
    id: z.ZodString;
    platform: z.ZodOptional<z.ZodString>;
  }, z.core.$loose>>;
  message: z.ZodObject<{
    id: z.ZodString;
    platform: z.ZodOptional<z.ZodString>;
    direction: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodOptional<z.ZodString>;
    sender: z.ZodOptional<z.ZodObject<{
      id: z.ZodString;
      platform: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    space: z.ZodObject<{
      id: z.ZodString;
      platform: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    content: z.ZodObject<{
      type: z.ZodString;
    }, z.core.$loose>;
  }, z.core.$loose>;
}, z.core.$loose>;
type SlimSender = z.infer<typeof slimSenderSchema>;
type SlimSpace = z.infer<typeof slimSpaceSchema>;
type SlimContent = z.infer<typeof slimContentSchema>;
type SlimMessageRef = z.infer<typeof slimMessageRefSchema>;
type SlimMessage = z.infer<typeof slimMessageSchema>;
type SlimEnvelope = z.infer<typeof slimEnvelopeSchema>;
//#endregion
//#region src/webhook/verify.d.ts
type VerifyResult = {
  ok: true;
} | {
  ok: false;
  reason: "missing-headers" | "expired" | "signature-mismatch";
};
interface VerifyInput {
  /** Request headers, keys lowercased. */
  headers: Record<string, string>;
  /** Epoch milliseconds; injectable for deterministic tests. */
  now?: number;
  /** The exact bytes received on the wire — never a re-encoded body. */
  rawBody: Uint8Array;
  /** The per-webhook signing secret. */
  secret: string;
}
/**
 * Verify a native Spectrum webhook signature.
 *
 * The header is `X-Spectrum-Signature: v0=<lowercase-hex>` where the hex digest
 * is `HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)` and `timestamp`
 * is the `X-Spectrum-Timestamp` header (unix seconds). The base string is built
 * over the **exact body bytes**: never JSON-parse-then-restringify before
 * verifying, or the bytes (key order, whitespace) change and the MAC won't
 * match.
 *
 * Implemented on Web Crypto (hence async) so it runs identically on Node, Bun,
 * and V8-isolate runtimes (Convex, Cloudflare Workers, Deno Deploy) — this is
 * part of the portable `@spectrum-ts/core/webhook` entry. `subtle` comes from
 * `uncrypto`, whose conditional exports pick `node:crypto`'s webcrypto under
 * Node and `globalThis.crypto` everywhere else, so this works on Node 18 (where
 * the global is not exposed by default) without a runtime feature check.
 *
 * The digest comparison is `subtle.verify`, which compares MACs in constant
 * time.
 */
export declare function verifySpectrumSignature(input: VerifyInput): Promise<VerifyResult>;
//#endregion
export type { SlimContent, SlimEnvelope, SlimMessage, SlimMessageRef, SlimSender, SlimSpace, VerifyInput, VerifyResult };