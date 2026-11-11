import { findBookByIdentifier, getDb } from "@/lib/db";
import { books, type Book } from "@/lib/db/schema";
import {
  INVENTORY_HELP,
  parseInventoryCommand,
  type InventoryVerb,
} from "@/lib/inventory-command";
import { findBookCandidates } from "@/lib/inventory-guess";
import {
  createBookFromTitle,
  executeCommand,
  secureEqual,
} from "@/lib/discord-inventory";

const PENDING_TTL_MS = 5 * 60 * 1000;

type PendingGuess = {
  verb: InventoryVerb;
  qty: number | null;
  candidates: Book[];
  expiresAt: number;
};

const pendingByChannel = new Map<string, PendingGuess>();

type DiscordCommand = {
  messageId?: string;
  channelId?: string;
  text?: string;
};

function reply(text: string | null) {
  return Response.json({ reply: text });
}

function parseGuessResponse(
  text: string,
  count: number,
): number | "cancel" | "invalid" {
  const value = text.toLowerCase();
  if (value === "no" || value === "n") return "cancel";
  if (value === "yes" || value === "y") return 0;
  const pick = Number(value);
  if (Number.isInteger(pick) && pick >= 1 && pick <= count) return pick - 1;
  return "invalid";
}

export async function POST(request: Request) {
  const secret = process.env.INVENTORY_DISCORD_SECRET?.trim();
  const allowedChannel = process.env.DISCORD_CHANNEL_ID?.trim();
  const pin = process.env.INVENTORY_DISCORD_PIN?.trim();

  if (!secret || !allowedChannel || !pin) {
    return new Response("Discord inventory is not configured.", {
      status: 503,
    });
  }

  const header = request.headers.get("x-inventory-secret") ?? "";
  if (!secureEqual(header, secret)) {
    console.error("Invalid Discord inventory secret");
    return new Response("Unauthorized.", { status: 401 });
  }

  let body: DiscordCommand | null;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }

  const messageId = body?.messageId?.trim() ?? "";
  const channelId = body?.channelId?.trim() ?? "";
  if (!messageId || !channelId) {
    return new Response("Missing messageId or channelId.", { status: 400 });
  }

  if (channelId !== allowedChannel) {
    console.warn(`Ignoring Discord command from channel ${channelId}`);
    return reply(null);
  }

  const text = (body?.text ?? "").trim();
  if (!text) return reply(null);

  try {
    const db = await getDb();

    // A pending guess is answered by a bare "yes" / "no" / number — no PIN.
    const pending = pendingByChannel.get(channelId);
    if (pending && !text.includes(" ")) {
      if (pending.expiresAt <= Date.now()) {
        pendingByChannel.delete(channelId);
      } else {
        const pick = parseGuessResponse(text, pending.candidates.length);
        if (pick === "cancel") {
          pendingByChannel.delete(channelId);
          return reply("Cancelled.");
        }
        if (pick === "invalid") {
          return reply(
            `Pick a number 1–${pending.candidates.length}, or "no" to cancel.`,
          );
        }
        const book = pending.candidates[pick];
        pendingByChannel.delete(channelId);
        const result = await executeCommand(
          db,
          messageId,
          channelId,
          pending.verb,
          book,
          pending.qty,
        );
        return reply(result);
      }
    }

    if (text.length > 160) return reply("Message too long.");

    const [pinToken, ...rest] = text.split(/\s+/);
    if (!secureEqual(pinToken ?? "", pin)) return reply("Unauthorized.");

    if (rest.length > 0) rest[0] = rest[0].replace(/^\//, "");
    const command = parseInventoryCommand(rest);
    if (!command) return reply(INVENTORY_HELP);

    const identifier = command.identifier.trim();
    const book = await findBookByIdentifier(db, identifier);

    if (book) {
      const result = await executeCommand(
        db,
        messageId,
        channelId,
        command.verb,
        book,
        command.qty,
      );
      return reply(result);
    }

    const candidates = findBookCandidates(
      await db.select().from(books),
      identifier,
    );

    if (candidates.length > 0) {
      pendingByChannel.set(channelId, {
        verb: command.verb,
        qty: command.qty,
        candidates,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });
      const list = candidates
        .map((candidate, index) => `${index + 1}. ${candidate.title} (${candidate.slug})`)
        .join("\n");
      return reply(
        `No book matches "${identifier}". Did you mean:\n${list}\nReply "yes" for the first, a number to choose, or "no" to cancel.`,
      );
    }

    if (command.verb === "ADD") {
      const qty = command.qty ?? 0;
      const created = await createBookFromTitle(db, identifier, qty);
      return reply(
        `Added "${created.title}" (${created.slug}): stock ${created.stock}. Price unset ($0.00) — set it with \`npm run books -- edit ${created.slug} --price 9.99\`.`,
      );
    }

    return reply(`No book matches "${identifier}".`);
  } catch (error) {
    console.error("Inventory Discord update failed", error);
    return new Response("Inventory update failed.", { status: 500 });
  }
}
