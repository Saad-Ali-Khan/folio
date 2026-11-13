import {queueTitleChoice} from "@/lib/title-choice";
import { eq } from "drizzle-orm";
import { readCoverLines } from "@/lib/cover-ocr";
import { books, discordCommands } from "@/lib/db/schema";
import { CatalogUnavailable, lookupCoverMetadata, lookupIsbnMetadata } from "@/lib/import-metadata";
import { getDb, findBookByIdentifier } from "@/lib/db";
import type { InventoryVerb } from "@/lib/inventory-command";
import {
  importDiscordBook,
  executeCommand,
  inventoryEditionKey,
  secureEqual,
} from "@/lib/discord-inventory";
import { decodeBarcode, normalizeIsbn } from "@/lib/inventory-scan";

const MAX_QTY = 999;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

const PHOTO_HELP =
  "Upload the front cover or ISBN barcode without a caption to add one copy. For a different quantity, use <PIN> ADD <quantity>.";

type ScanCommand = { verb: InventoryVerb; qty: number };

function parseScanCommand(tokens: string[]): ScanCommand | "invalid" {
  if (tokens.length === 0) return { verb: "ADD", qty: 1 };

  const verb = tokens[0].toUpperCase();
  if (verb !== "ADD" && verb !== "SET" && verb !== "SOLD") return "invalid";

  if (tokens.length === 1) return { verb, qty: 1 };
  if (tokens.length > 2) return "invalid";

  const qty = Number(tokens[1]);
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) return "invalid";
  if ((verb === "ADD" || verb === "SOLD") && qty < 1) return "invalid";

  return { verb, qty };
}

function reply(text: string | null) {
  return Response.json({ reply: text });
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

  if (!secureEqual(request.headers.get("x-inventory-secret") ?? "", secret)) {
    console.error("Invalid Discord inventory secret");
    return new Response("Unauthorized.", { status: 401 });
  }

  const channelId = request.headers.get("x-channel-id")?.trim() ?? "";
  const messageId = request.headers.get("x-message-id")?.trim() ?? "";
  const userId = request.headers.get("x-user-id")?.trim() ?? "";
  if (!messageId || !channelId) {
    return new Response("Missing message-id or channel-id.", { status: 400 });
  }

  if (channelId !== allowedChannel) {
    console.warn(`Ignoring Discord photo from channel ${channelId}`);
    return reply(null);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return new Response("Expected an image body.", { status: 400 });
  }

  const caption = request.headers.get("x-command-text")?.trim() ?? "";
  let command: ScanCommand = { verb: "ADD", qty: 1 };
  if (caption) {
    const [pinToken, ...rest] = caption.split(/\s+/);
    if (!secureEqual(pinToken, pin)) return reply("Incorrect inventory PIN.");
    const parsed = parseScanCommand(rest);
    if (parsed === "invalid") return reply(PHOTO_HELP);
    command = parsed;
  } else {
    // Both identities come from the authenticated Discord bot, not the caption.
    const allowedUsers = (process.env.DISCORD_PHOTO_USER_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean);
    const owner = request.headers.get("x-guild-owner-id");
    if (!userId || !(allowedUsers.length ? allowedUsers.includes(userId) : userId === owner)) {
      return reply("Your account is not enabled for photo-only imports. Ask the store operator to enable it.");
    }
  }

  if (Number(request.headers.get("content-length")) > MAX_PHOTO_BYTES) return reply("This photo exceeds 12 MB. Send a smaller image.");

  try {
    const image = Buffer.from(await request.arrayBuffer());
    if (image.length > MAX_PHOTO_BYTES) return reply("This photo exceeds 12 MB. Send a smaller image.");
    const db = await getDb();
    const [processed] = await db.select({ id: discordCommands.id }).from(discordCommands).where(eq(discordCommands.messageId, messageId));
    if (processed) return reply("Already processed.");

    const rawCode = await decodeBarcode(image);
    if (!rawCode) {
      if (command.verb !== "ADD") return reply("Include a readable ISBN barcode for SET or SOLD.");
      let firstMatch;
      try {
        firstMatch = await lookupCoverMetadata(await readCoverLines(image));
      } catch (error) {
        if (!(error instanceof CatalogUnavailable)) throw error;
        console.warn("First cover catalog lookup failed. Retrying with focused OCR.", error.cause);
      }
      const meta = firstMatch ?? await lookupCoverMetadata(await readCoverLines(image, true), true);
      const key = meta && inventoryEditionKey(meta);
      if (!meta || !key) return reply("I couldn’t confidently identify this book. Send a sharper photo showing the title and author, or the ISBN barcode.");

      const [coverDraft] = await db.select({ id: books.id, status: books.status }).from(books).where(eq(books.isbn, key));
      if (coverDraft?.status === "published") return reply("This cover matches a published book with an unverified edition. Send the ISBN barcode to identify the copy.");
      if (!coverDraft && meta.titleOptions) {
        return Response.json(await queueTitleChoice(db, messageId, channelId, userId, meta, command.qty));
      }
      const received = await importDiscordBook(db, messageId, channelId, meta, command.qty);
      if (!received) return reply("Already processed.");
      return reply(`Received ${command.qty} ${command.qty === 1 ? "copy" : "copies"} of ${received.title}. Draft stock: ${received.stock}. Review the edition in inventory.`);
    }

    const isbn = normalizeIsbn(rawCode);
    if (!isbn) {
      return reply(`Decoded "${rawCode}" but it is not a book ISBN (need EAN-13 starting 978/979).`);
    }

    const book = await findBookByIdentifier(db, isbn);

    if (book) {
      const result = await executeCommand(
        db,
        messageId,
        channelId,
        command.verb,
        book,
        command.qty,
      );
      return reply(result ?? `Already processed. (${book.title}: ${book.stock} in stock.)`);
    }


    if (command.verb !== "ADD") return reply("Unknown ISBN. Use ADD to receive a new book first.");
    const lookup = await lookupIsbnMetadata(isbn);
    const meta = lookup.status === "found" ? lookup.metadata : {
      title: `ISBN ${isbn}`,
      author: "Unknown author",
      isbn,
      coverUrl: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`,
      titleNote: lookup.status === "missing"
        ? "No matching record was found for this ISBN. I saved an ISBN-only draft for you to complete in inventory."
        : "The catalog lookup failed. I saved an ISBN-only draft for you to complete in inventory.",
    };

    if (meta.titleOptions) return Response.json(await queueTitleChoice(db, messageId, channelId, userId, meta, command.qty));
    const created = await importDiscordBook(db, messageId, channelId, meta, command.qty);
    if (!created) return reply("Already processed.");
    return reply(
      `Added "${created.title}" (${created.slug}) from ISBN ${isbn}: stock ${created.stock}. ${meta.titleNote ?? ""} Draft saved; set a price and publish before selling. Set price with \`npm run books -- edit ${created.slug} --price 1500\`.`,
    );
  } catch (error) {
    if (error instanceof CatalogUnavailable) {
      console.warn("Cover catalog unavailable after retry", error.cause);
      return reply("I scanned the cover, but the book catalog didn’t respond. Resend the same photo in a moment, or scan the ISBN barcode.");
    }
    console.error("Inventory Discord photo failed", error);
    return new Response("Inventory photo scan failed.", { status: 500 });
  }
}
