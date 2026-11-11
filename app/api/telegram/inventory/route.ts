import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { findBookByIdentifier, getDb } from "@/lib/db";
import { books, telegramUpdates } from "@/lib/db/schema";
import {
  INVENTORY_HELP,
  parseInventoryCommand,
} from "@/lib/inventory-command";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
};

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ok() {
  return Response.json({ ok: true });
}

async function sendMessage(token: string, chatId: string, text: string) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) {
      console.error(
        "Telegram sendMessage failed",
        response.status,
        await response.text(),
      );
    }
  } catch (error) {
    console.error("Telegram sendMessage failed", error);
  }
}

export async function POST(request: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const allowedChat = process.env.INVENTORY_TELEGRAM_CHAT_ID?.trim();
  const pin = process.env.INVENTORY_TELEGRAM_PIN?.trim();

  if (!token || !secret || !allowedChat || !pin) {
    return new Response("Telegram inventory is not configured.", {
      status: 503,
    });
  }

  const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secureEqual(header, secret)) {
    console.error("Invalid Telegram webhook secret token");
    return new Response("Unauthorized.", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }

  const message = update.message;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : "";
  const updateId = update.update_id != null ? String(update.update_id) : "";
  if (!chatId || !updateId) return ok();

  if (chatId !== allowedChat) {
    console.warn(`Ignoring Telegram command from chat ${chatId}`);
    return ok();
  }

  const text = (message?.text ?? "").trim();
  if (!text) return ok();
  if (text.length > 160) {
    await sendMessage(token, chatId, "Message too long.");
    return ok();
  }

  const [pinToken, ...rest] = text.split(/\s+/);
  if (!secureEqual(pinToken ?? "", pin)) {
    await sendMessage(token, chatId, "Unauthorized.");
    return ok();
  }

  if (rest.length > 0) rest[0] = rest[0].replace(/^\//, "");
  const command = parseInventoryCommand(rest);
  if (!command) {
    await sendMessage(token, chatId, INVENTORY_HELP);
    return ok();
  }

  const identifier = command.identifier.trim();

  try {
    const db = await getDb();
    const book = await findBookByIdentifier(db, identifier);

    if (!book) {
      await sendMessage(token, chatId, `No book matches "${identifier}".`);
      return ok();
    }

    if (command.verb === "GET") {
      await sendMessage(
        token,
        chatId,
        `${book.title} (${book.slug}): ${book.stock} in stock.`,
      );
      return ok();
    }

    const qty = command.qty ?? 0;
    const summary = `${command.verb} ${book.slug} ${qty}`;

    const outcome = await db.transaction(async (tx) => {
      const [logged] = await tx
        .insert(telegramUpdates)
        .values({ updateId, chatId, command: summary })
        .onConflictDoNothing({ target: telegramUpdates.updateId })
        .returning({ id: telegramUpdates.id });

      if (!logged) return { duplicate: true as const };

      const nextStock =
        command.verb === "SET"
          ? qty
          : command.verb === "ADD"
            ? sql`${books.stock} + ${qty}`
            : sql`greatest(${books.stock} - ${qty}, 0)`;

      const [updated] = await tx
        .update(books)
        .set({ stock: nextStock })
        .where(eq(books.id, book.id))
        .returning({ stock: books.stock });

      return { duplicate: false as const, stock: updated.stock };
    });

    if (outcome.duplicate) return ok();

    await sendMessage(
      token,
      chatId,
      `OK ${book.slug}: stock ${outcome.stock} (was ${book.stock}).`,
    );
    return ok();
  } catch (error) {
    console.error("Inventory Telegram update failed", error);
    return new Response("Inventory update failed.", { status: 500 });
  }
}
