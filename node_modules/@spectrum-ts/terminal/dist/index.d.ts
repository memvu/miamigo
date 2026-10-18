import { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import { Content } from "@spectrum-ts/core";
import z from "zod";
//#region src/protocol.d.ts
type ProtocolContent = {
  type: "text";
  text: string;
} | {
  type: "attachment";
  name: string;
  mimeType: string;
  size?: number;
  bytes?: string;
  path?: string;
} | {
  type: "voice";
  name?: string;
  mimeType: string;
  size?: number;
  bytes?: string;
  path?: string;
} | {
  type: "contact";
  name?: {
    formatted?: string;
    first?: string;
    last?: string;
  };
  vcard?: string;
} | {
  type: "custom";
  raw: unknown;
};
interface ProtocolMessageNotification {
  content: ProtocolContent;
  id: string;
  replyTo?: {
    messageId: string;
  };
  senderId: string;
  spaceId: string;
  timestamp: string;
}
interface ProtocolReactionNotification {
  messageId: string;
  reaction: string;
  senderId: string;
  spaceId: string;
  timestamp: string;
}
declare class RpcSession {
  private readonly decoder;
  private nextId;
  private readonly pending;
  private onNotify;
  private onClose;
  private closed;
  private readonly socket;
  constructor(socket: Socket);
  handleNotifications(h: (method: string, params: unknown) => void): void;
  onClosed(h: () => void): void;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(): void;
  private handle;
  private shutdown;
}
//#endregion
//#region src/index.d.ts
interface ConsoleHijack {
  restore: () => void;
}
type InboundEvent = {
  kind: "message";
  value: ProtocolMessageNotification;
} | {
  kind: "reaction";
  value: ProtocolReactionNotification;
};
interface TerminalClient {
  events: AsyncIterable<InboundEvent>;
  hijack: ConsoleHijack;
  knownChats: Set<string>;
  nextChatIndex: number;
  proc: ChildProcess;
  session: RpcSession;
}
type SpectrumContent = Content;
interface TerminalInboundMessage {
  content: SpectrumContent;
  id: string;
  replyTo?: {
    messageId: string;
  };
  sender: {
    id: string;
  };
  space: {
    id: string;
  };
  timestamp: Date;
}
export declare const terminal: import("@spectrum-ts/core").Platform<import("@spectrum-ts/core").PlatformDef<"terminal", z.ZodObject<{
  commands: z.ZodOptional<z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
}, z.core.$strip>, z.ZodType<object, unknown, z.core.$ZodTypeInternals<object, unknown>> | undefined, z.ZodType<object, unknown, z.core.$ZodTypeInternals<object, unknown>> | undefined, z.ZodType<object, unknown, z.core.$ZodTypeInternals<object, unknown>> | undefined, TerminalClient, {
  id: string;
}, {
  id: string;
}, z.ZodObject<{
  replyTo: z.ZodOptional<z.ZodObject<{
    messageId: z.ZodString;
  }, z.core.$strip>>;
}, z.core.$strip>, TerminalInboundMessage, undefined, Record<never, never>, Record<never, never>, Record<never, never>>> & Readonly<Record<never, never>>;
//#endregion