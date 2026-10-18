import { IMessageSDK } from "@photon-ai/imessage-kit";

const sdk = new IMessageSDK({
  databasePath: process.env.MESSAGES_DATABASE_PATH,
});
try {
  const chats = await sdk.listChats({ kind: "group", sortBy: "recent" });
  for (const chat of chats) {
    process.stdout.write(
      `${JSON.stringify({ id: chat.chatId, name: chat.name, lastMessage: chat.lastMessageAt })}\n`,
    );
  }
} finally {
  await sdk.close();
}
