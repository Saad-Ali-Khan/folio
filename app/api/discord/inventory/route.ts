import {queueTitleChoice,resolveTitleChoice} from "@/lib/title-choice";
import { resolveCoverBarcode } from "@/lib/pending-covers";
import { notifyCoverCleanup } from "@/lib/notify-cover-cleanup";
import { MAX_STOCK_CHOICES, queueStockChoice, resolveStockChoice } from "@/lib/discord-stock-choice";
import { findBooksByIdentifier, getDb } from "@/lib/db";
import { eq } from "drizzle-orm";
import { books } from "@/lib/db/schema";
import {
  INVENTORY_HELP,
  parseInventoryCommand,
} from "@/lib/inventory-command";
import { findBookCandidates } from "@/lib/inventory-guess";
import { MAX_BOOK_PRICE_PKR } from "@/lib/store-policy";
import {
  importDiscordBook,
  fetchMetadataByTitle,
  fetchMetadataByIsbn,
  executeCommand,
  secureEqual,
  AmbiguousInventoryTitle,
} from "@/lib/discord-inventory";

type DiscordCommand = {
  userId?: string;
  messageId?: string;
  channelId?: string;
  text?: string;
  titleChoice?: { id?: unknown; selection?: unknown };
  coverChoice?: { id?: unknown; selection?: unknown };
};

const ambiguousTitle = "Multiple editions match. Use the edition’s ISBN or prefix its slug with slug:.";

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

  // Button interactions carry the account ID from Discord through the signed bot request.
  if (body?.coverChoice) {
    const { id, selection } = body.coverChoice;
    if (typeof id !== "string" || !/^[0-9a-f]{10}$/.test(id) || typeof selection !== "string" || typeof body.userId !== "string") return reply("Invalid cover confirmation.");
    try { const result=await resolveCoverBarcode(await getDb(), id, channelId, body.userId, selection);await notifyCoverCleanup(result.cleanupAt);return Response.json(result); }
    catch { const cleanupAt=new Date(Date.now()+120_000).toISOString();await notifyCoverCleanup(cleanupAt);return Response.json({ reply: "Could not confirm this cover. Check inventory before retrying; a completed import will not be added twice.", cleanupAt }); }
  }
  if (body?.titleChoice) {
    const { id, selection } = body.titleChoice;
    if (typeof id !== "string" || !/^[0-9a-f]{10}$/.test(id) || typeof selection !== "string" || typeof body.userId !== "string") {
      return reply("Invalid title choice.");
    }
    try {
      return Response.json(await resolveTitleChoice(await getDb(), id, channelId, body.userId, selection));
    } catch (error) {
      if (error instanceof AmbiguousInventoryTitle) return Response.json({ reply: error.message });
      console.error("Discord title choice failed", error);
      return reply("Could not save that title choice. Try again.");
    }
  }

  const text = (body?.text ?? "").trim();
  if (!text) return reply(null);

  try {
    const db = await getDb();

    if (text.length > 160) return reply("Message too long.");

    const [pinToken, ...rest] = text.split(/\s+/);
    if (!secureEqual(pinToken ?? "", pin)) return reply("Unauthorized.");

    if (rest.length > 0) rest[0] = rest[0].replace(/^\//, "");

    const action = rest[0]?.toUpperCase();
    if (action === "CONFIRM") {
      return reply(await resolveStockChoice(db, rest[1] ?? "", body?.userId ?? "", channelId, rest[2] ?? ""));
    }
    if(action === "TITLE") return Response.json(await resolveTitleChoice(db,rest[1]??"",channelId,body?.userId??"",(rest[2]??"").toUpperCase()));
    if(action === "TITLES") {
      const [target, other] = await findBooksByIdentifier(db, rest.slice(1).join(" "));
      if (other) return reply(ambiguousTitle);
      if(!target)return reply("Book not found. Use the ISBN or exact slug.");
      const meta=await fetchMetadataByIsbn(target.isbn);
      if(!meta)return reply("Title lookup unavailable; edit the title manually in inventory.");
      if(!meta.titleOptions)return reply(meta.titleNote ?? "No differing original and English titles were found. You can edit the title in inventory.");
      return Response.json(await queueTitleChoice(db,messageId,channelId,body?.userId??"",meta,0,target.id));
    }
    if (["PRICE", "PUBLISH", "DRAFT"].includes(action)) {
      const identifier = rest.slice(1, action === "PRICE" ? -1 : undefined).join(" ");
      const [target, other] = await findBooksByIdentifier(db, identifier);
      if (other) return reply(ambiguousTitle);
      if (!target) return reply("No matching book. Use its ISBN or slug.");
      if (action === "PRICE") {
        const amount = rest.at(-1) ?? "";
        const price = Number(amount);
        if (!/^\d+(\.\d{1,2})?$/.test(amount) || price <= 0) return reply("Use PRICE <isbn|slug> <amount>, e.g. PRICE dune 14.99.");
        if (price > MAX_BOOK_PRICE_PKR) return reply(`The maximum book price is Rs ${MAX_BOOK_PRICE_PKR.toLocaleString("en-PK")}.`);
        await db.update(books).set({priceCents: Math.round(price*100)}).where(eq(books.id,target.id));
        return reply("Price updated. Publish the book when ready.");
      }
      if (action === "PUBLISH" && (target.priceCents <= 0 || !target.title.trim() || target.author === "Unknown author")) return reply("Set a positive price and review title/author before publishing.");
      await db.update(books).set({status: action === "PUBLISH" ? "published" : "draft"}).where(eq(books.id,target.id));
      return reply(action === "PUBLISH" ? "Book published." : "Book moved to drafts.");
    }
    const command = parseInventoryCommand(rest);
    if (!command) return reply(INVENTORY_HELP);

    const identifier = command.identifier.trim();
    const exact = await findBooksByIdentifier(db, identifier, MAX_STOCK_CHOICES + 1);
    const source = { messageId, channelId, userId: body?.userId ?? "" };
    if (exact.length > MAX_STOCK_CHOICES) return reply(ambiguousTitle);
    if (exact.length > 1) return reply(await queueStockChoice(db, source, command, exact));
    const [book] = exact;

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
    if (identifier.toLowerCase().startsWith("slug:")) return reply("No book uses that slug.");

    const candidates = findBookCandidates(
      await db.select().from(books),
      identifier,
    );

    if (candidates.length > 0) {
      return reply(await queueStockChoice(db, source, command, candidates));
    }

    if (command.verb === "ADD") {
      const qty = command.qty ?? 0;
      const meta=await fetchMetadataByTitle(identifier);
      if(meta.titleOptions)return Response.json(await queueTitleChoice(db,messageId,channelId,body?.userId??"",meta,qty));
      const created = await importDiscordBook(db, messageId, channelId, meta, qty);
      if (!created) return reply("Already processed.");
      return reply(
        `Added "${created.title}" (${created.slug}): stock ${created.stock}. ${meta.titleNote ?? ""} Draft saved; set a price and publish before selling. Set price with \`npm run books -- edit ${created.slug} --price 1500\`.`,
      );
    }

    return reply(`No book matches "${identifier}".`);
  } catch (error) {
    if (error instanceof AmbiguousInventoryTitle) return reply(error.message);
    console.error("Inventory Discord update failed", error);
    return new Response("Inventory update failed.", { status: 500 });
  }
}
