import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "./db";
import { books, discordStockChoices, type Book } from "./db/schema";
import { executeCommand } from "./discord-inventory";
import type { InventoryVerb } from "./inventory-command";

export async function queueStockChoice(
  db: Database,
  source: { messageId: string; userId: string; channelId: string },
  command: { verb: InventoryVerb; qty: number | null },
  candidates: Book[],
): Promise<string> {
  if (!source.userId) return "Restart the Discord bot to enable book confirmations, or send the book’s exact ISBN or slug.";
  const [choice] = await db.insert(discordStockChoices).values({
    id: randomBytes(5).toString("hex"),
    sourceMessageId: source.messageId,
    userId: source.userId,
    channelId: source.channelId,
    bookIds: candidates.map(book => book.id),
    verb: command.verb,
    qty: command.qty,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  }).onConflictDoNothing().returning({ id: discordStockChoices.id });
  if (!choice) return "This command already has a confirmation request. Use the original prompt or send a new command.";
  const list = candidates.map((book, index) => `${index + 1}. ${book.title} (${book.slug})`).join("\n");
  return `Which book did you mean?\n${list}\nReply with your PIN followed by CONFIRM ${choice.id} and the book number. To cancel, use CONFIRM ${choice.id} CANCEL. The choice expires in 5 minutes.`;
}

export async function resolveStockChoice(db: Database, id: string, userId: string, channelId: string, selection: string) {
  return db.transaction(async tx => {
    const [choice] = await tx.select().from(discordStockChoices).where(eq(discordStockChoices.id, id)).for("update");
    if (!choice || !userId || choice.userId !== userId || choice.channelId !== channelId) {
      return "Confirmation not found for your account and channel.";
    }
    if (choice.resolved) return "This confirmation was already handled.";
    if (choice.expiresAt.getTime() <= Date.now()) return "Confirmation expired. Send the inventory command again.";

    const cancel = selection.toUpperCase() === "CANCEL";
    const index = /^\d+$/.test(selection) ? Number(selection) - 1 : -1;
    if (!cancel && (index < 0 || index >= choice.bookIds.length)) return "Choose a book number from the prompt or CANCEL.";

    if (cancel) {
      await tx.update(discordStockChoices).set({ resolved: 1 }).where(eq(discordStockChoices.id, id));
      return "Cancelled.";
    }
    const [book] = await tx.select().from(books).where(eq(books.id, choice.bookIds[index]));
    if (!book) return "That book is no longer in inventory.";
    const result = await executeCommand(tx as unknown as Database, choice.sourceMessageId, channelId, choice.verb, book, choice.qty);
    await tx.update(discordStockChoices).set({ resolved: 1 }).where(eq(discordStockChoices.id, id));
    return result ?? "This command was already processed.";
  });
}
