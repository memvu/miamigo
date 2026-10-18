import { IMessageSDK } from "@photon-ai/imessage-kit";

const sdk = new IMessageSDK({
  databasePath: process.env.MESSAGES_DATABASE_PATH,
});
try {
  const chats = await sdk.listChats({ sortBy: "recent", limit: 30 });
  for (const chat of chats) {
    process.stdout.write(
      `${JSON.stringify({
        id: chat.chatId,
        kind: chat.kind,
        name: chat.name ?? (chat.kind === "dm" ? chat.chatId.replace(/^any;[-+];/, "") : "Unnamed Group"),
        lastMessage: chat.lastMessageAt,
      })}\n`,
    );
  }
} finally {
  await sdk.close();
}
