import {queueTitleChoice} from "@/lib/title-choice";
import { and, eq, gt } from "drizzle-orm";
import { recognizeCover } from "@/lib/cover-recognition";
import { books, discordCommands, pendingCovers } from "@/lib/db/schema";
import { CatalogUnavailable, lookupIsbnMetadata } from "@/lib/import-metadata";
import { findBooksByIsbn, getDb } from "@/lib/db";
import { MAX_STOCK_CHOICES, queueStockChoice } from "@/lib/discord-stock-choice";
import type { InventoryVerb } from "@/lib/inventory-command";
import {
  importDiscordBook,
  executeCommand,
  inventoryEditionKey,
  secureEqual,
} from "@/lib/discord-inventory";
import { decodeBarcode, normalizeIsbn } from "@/lib/inventory-scan";
import { prepareUploadedCover } from "@/lib/uploaded-cover";
import { lookupPublisherCover } from "@/lib/publisher-cover";
import { PhotoImportError, storeImportPhoto } from "@/lib/import-photo";
import { queueCoverBarcode, retainFailedCover } from "@/lib/pending-covers";
import { notifyCoverCleanup } from "@/lib/notify-cover-cleanup";
import {suggestCoverCandidates} from "@/lib/cover-suggestions";
import {queueSuggestedCover} from "@/lib/suggested-cover";
import type {CoverLine} from "@/lib/cover-ocr";

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

async function retainCover(image: Buffer, messageId: string, channelId: string, userId: string, qty: number, reason?: string, lines?:CoverLine[]) {
  if (process.env.PHOTO_STORAGE !== "r2") return reply(`${reason ?? "I couldn’t match this cover to a verified catalog record."} No stock was added. Send the ISBN barcode, or try the cover again later.`);
  try {
    const data = Buffer.from(await prepareUploadedCover(image), "base64");
    const result=await retainFailedCover(await getDb(), messageId, channelId, userId, data, qty);
    await notifyCoverCleanup(result.cleanupAt);
    if(result.manualCoverId && lines) {
      // Catalog outages/timeouts leave the existing barcode/manual fallback usable.
      try {
        const candidates=await suggestCoverCandidates(image,lines);
        const suggested=candidates.length?await queueSuggestedCover(await getDb(),result.manualCoverId,userId,channelId,candidates):null;
        if(suggested)return Response.json(suggested);
      } catch { /* A proposal failure must not discard the retained cover. */ }
    }
    return Response.json({ ...result, reply: result.reply.replace("I couldn’t identify this cover.",
      reason ?? "I couldn’t match this cover to a verified catalog record.") });
  } catch (error) {
    const cause=error instanceof Error ? error.cause : undefined;
    const code=cause && typeof cause === "object" && "code" in cause ? cause.code : "unknown";
    const safeMessage=error instanceof Error && /^(R2 (?:PUT|GET)|Folio's|Photo upload|Too many|Photo exceeds)/.test(error.message) ? error.message : "Storage or database operation failed.";
    console.warn("Cover retention failed",{code,reason:safeMessage});
    const cleanupAt=new Date(Date.now() + 15 * 60_000).toISOString();await notifyCoverCleanup(cleanupAt);
    return Response.json({ reply: "I couldn’t identify or retain this cover. No stock was added. Check photo storage/limits, or send the barcode to import without a cover.", cleanupAt });
  }
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

  let unidentifiedCover: Buffer | undefined;
  try {
    const image = Buffer.from(await request.arrayBuffer());
    if (image.length > MAX_PHOTO_BYTES) return reply("This photo exceeds 12 MB. Send a smaller image.");
    const db = await getDb();
    const [processed] = await db.select({ id: discordCommands.id }).from(discordCommands).where(eq(discordCommands.messageId, messageId));
    if (processed) return reply("Already processed.");

    const rawCode = await decodeBarcode(image);
    if (!rawCode) {
      if (command.verb !== "ADD") return reply("Include a readable ISBN barcode for SET or SOLD.");
      unidentifiedCover = image;
      const recognition = await recognizeCover(image);
      console.info("Cover recognition completed", { stage: recognition.stage, matched: Boolean(recognition.metadata) });
      const initialLines = recognition.lines;
      let meta = recognition.metadata;
      const key = meta && inventoryEditionKey(meta);
      if (!meta || !key) return retainCover(image, messageId, channelId, userId, command.qty,undefined,recognition.suggestionLines??initialLines);
      unidentifiedCover = undefined;

      const [coverDraft] = await db.select({ id: books.id, status: books.status }).from(books).where(eq(books.isbn, key));
      if (coverDraft?.status === "published") return reply("This cover matches a published book with an unverified edition. Send the ISBN barcode to identify the copy.");
      meta = await lookupPublisherCover(image, meta, initialLines.map(line => line.text));
      meta = { ...meta, ...await storeImportPhoto(db, await prepareUploadedCover(image)) };
      if (!coverDraft && meta.titleOptions) {
        return Response.json(await queueTitleChoice(db, messageId, channelId, userId, meta, command.qty));
      }
      const received = await importDiscordBook(db, messageId, channelId, meta, command.qty);
      if (!received) return reply("Already processed.");
      return reply(`Received ${command.qty} ${command.qty === 1 ? "copy" : "copies"} of ${received.title}. Draft stock: ${received.stock}. Uploaded cover saved as the second listing photo. Review the edition in inventory.`);
    }

    const isbn = normalizeIsbn(rawCode);
    if (!isbn) {
      return reply(`Decoded "${rawCode}" but it is not a book ISBN (need EAN-13 starting 978/979).`);
    }

    const listings = await findBooksByIsbn(db, isbn, MAX_STOCK_CHOICES + 1);
    if (listings.length > 1) {
      if (listings.length > MAX_STOCK_CHOICES) return reply("This ISBN has many listings. Use id:<listing ID> or slug:<listing slug> in an inventory command. No stock was changed.");
      const [retained] = await db.select({ id: pendingCovers.id }).from(pendingCovers).where(and(eq(pendingCovers.userId, userId),
        eq(pendingCovers.channelId, channelId), eq(pendingCovers.state, "waiting"), gt(pendingCovers.expiresAt, new Date()))).limit(1);
      if (retained && command.verb === "ADD") return reply("This ISBN is shared by several listings, so I haven’t added stock or attached the saved cover. Use its Enter title and author button to create a separate draft, then link the ISBN in admin; or use an exact listing ID to receive stock into an existing listing.");
      return reply(await queueStockChoice(db, { messageId, channelId, userId }, { verb: command.verb, qty: command.qty }, listings));
    }
    const [book] = listings;

    if (book) {
      if (command.verb === "ADD") {
        const match = await queueCoverBarcode(db, messageId, channelId, userId, { title: book.title, author: book.author, isbn: book.isbn, coverUrl: book.coverUrl }, command.qty, Boolean(caption));
        if (match) return Response.json(match);
      }
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

    const match = await queueCoverBarcode(db, messageId, channelId, userId, meta, command.qty, Boolean(caption));
    if (match) return Response.json(match);
    if (meta.titleOptions) return Response.json(await queueTitleChoice(db, messageId, channelId, userId, meta, command.qty));
    const created = await importDiscordBook(db, messageId, channelId, meta, command.qty);
    if (!created) return reply("Already processed.");
    return reply(
      `Added "${created.title}" (${created.slug}) from ISBN ${isbn}: stock ${created.stock}. ${meta.titleNote ?? ""} Draft saved; set a price and publish before selling. Set price with \`npm run books -- edit ${created.slug} --price 1500\`.`,
    );
  } catch (error) {
    if (error instanceof Error && /Cover scanning is busy/.test(error.message)) return reply(error.message);
    if (unidentifiedCover && (error instanceof CatalogUnavailable || error instanceof Error && /Cover scanning timed out/.test(error.message))) {
      return retainCover(unidentifiedCover, messageId, channelId, userId, command.qty,
        error instanceof CatalogUnavailable ? "The book catalog didn’t respond after retrying." : "The cover scan reached its time limit.");
    }
    if (error instanceof PhotoImportError) return reply(error.message);
    if (error instanceof CatalogUnavailable) {
      console.warn("Cover catalog unavailable after retry", error.cause);
      return reply("I scanned the cover, but the book catalog didn’t respond. Resend the same photo in a moment, or scan the ISBN barcode.");
    }
    console.error("Inventory Discord photo failed", error);
    return new Response("Inventory photo scan failed.", { status: 500 });
  }
}
