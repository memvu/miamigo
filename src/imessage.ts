import { Database } from "bun:sqlite";
import type { Message } from "@photon-ai/imessage-kit";
import { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Config } from "./config";
import type { IncomingMessage, Participant } from "./contracts";
import type { Store } from "./db";

const CONTROL_CHARACTERS = /\p{Cc}/gu;
const TAPBACKS: Record<string, string> = {
  like: "👍",
  emphasize: "‼️",
  love: "❤️",
  dislike: "👎",
  laugh: "😂",
  question: "❓",
};

export function incoming(message: Message): IncomingMessage | null {
  if (!message.chatId || message.retractedAt !== null) return null;
  return {
    id: message.id,
    chatId: message.chatId,
    handle: message.participant ?? (message.isFromMe ? "__bot__" : ""),
    text: message.text ?? "",
    at: message.createdAt.getTime(),
    isFromMe: message.isFromMe,
    isGroup: message.chatKind === "group",
    kind: message.reaction
      ? "reaction"
      : message.hasAttachments && !message.text
        ? "attachment"
        : message.kind,
    replyTo: message.threadRootMessageId ?? undefined,
    ...(message.reaction?.targetMessageId
      ? {
          reaction: {
            targetId: message.reaction.targetMessageId,
            emoji:
              message.reaction.emoji ??
              TAPBACKS[message.reaction.kind] ??
              message.reaction.kind,
            removed: message.reaction.isRemoved,
          },
        }
      : {}),
  };
}

export async function loadContacts(
  path: string,
): Promise<Record<string, Omit<Participant, "handle">>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const value: unknown = await file.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("contacts.json must map handles to contact records.");
  const contacts: Record<string, Omit<Participant, "handle">> = {};
  for (const [handle, contact] of Object.entries(value)) {
    if (
      !contact ||
      typeof contact !== "object" ||
      !("name" in contact) ||
      typeof contact.name !== "string" ||
      !contact.name.trim()
    )
      throw new Error("Each contact needs a nonempty name.");
    const person: Omit<Participant, "handle"> = {
      name: contact.name.replace(CONTROL_CHARACTERS, " ").trim(),
    };
    for (const field of ["venmo", "zelle"] as const) {
      if (field in contact) {
        const entry = contact[field as keyof typeof contact];
        if (typeof entry !== "string")
          throw new Error("Payment contact handles must be text.");
        person[field] = entry.replace(CONTROL_CHARACTERS, " ");
      }
    }
    contacts[handle] = person;
  }
  return contacts;
}

export class NativeIMessage {
  private readonly sdk: IMessageSDK;
  private readonly messages: Database;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly contacts: Record<string, Omit<Participant, "handle">>,
  ) {
    this.messages = new Database(config.messagesDatabasePath, {
      readonly: true,
    });
    this.sdk = new IMessageSDK({
      databasePath: config.messagesDatabasePath,
      maxConcurrentSends: 1,
      sendTimeout: 15_000,
      plugins: [
        {
          name: "miamigo-allowlist-and-rate-limit",
          onBeforeSend: ({ request }) => {
            if (!config.allowedChats.has(request.to))
              throw new Error("The destination is not in ALLOWED_CHAT_IDS.");
            store.reserveSend(request.to, Date.now());
          },
        },
      ],
    });
  }

  refreshParticipants(chatId: string): void {
    const rows = this.messages
      .query<{ handle: string }, [string]>(
        "SELECT DISTINCT h.id AS handle FROM chat c JOIN chat_handle_join j ON j.chat_id=c.ROWID JOIN handle h ON h.ROWID=j.handle_id WHERE c.guid=? ORDER BY h.id",
      )
      .all(chatId);
    this.store.setParticipants(
      chatId,
      rows.map((row) => ({
        handle: row.handle,
        ...(this.contacts[row.handle] ?? { name: row.handle }),
      })),
    );
  }

  async start(
    receive: (message: IncomingMessage) => void,
    report: (error: unknown) => void,
  ): Promise<void> {
    const chats = await this.sdk.listChats();
    for (const chatId of this.config.allowedChats) {
      const chat = chats.find((item) => item.chatId === chatId);
      if (!chat)
        throw new Error(
          "An ALLOWED_CHAT_IDS entry does not match an existing Messages chat. Run bun run list-chats.",
        );
      if (chat.kind !== "group" && !this.config.allowDMs)
        throw new Error(
          "A selected chat is not a group. DMs require ALLOW_DMS=true.",
        );
      this.store.ensureChat(chatId, this.config.tz, chat.name ?? "");
      this.refreshParticipants(chatId);
    }
    const handle = (native: Message): void => {
      if (!native.chatId || !this.config.allowedChats.has(native.chatId))
        return;
      if (native.kind === "memberAdded" || native.kind === "memberRemoved")
        this.refreshParticipants(native.chatId);
      const message = incoming(native);
      if (message) receive(message);
    };
    await this.sdk.startWatching({
      onIncomingMessage: handle,
      onFromMeMessage: handle,
      onError: report,
    });
  }

  async send(
    chatId: string,
    text: string,
    attachments?: string[],
  ): Promise<void> {
    await this.sdk.send({ to: chatId, text, attachments });
  }

  async close(): Promise<void> {
    try {
      await this.sdk.close();
    } finally {
      this.messages.close();
    }
  }
}
