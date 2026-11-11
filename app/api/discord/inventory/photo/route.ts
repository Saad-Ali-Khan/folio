import { getDb, findBookByIdentifier } from "@/lib/db";
import type { InventoryVerb } from "@/lib/inventory-command";
import {
  createBook,
  executeCommand,
  fetchMetadataByIsbn,
  logScan,
  secureEqual,
} from "@/lib/discord-inventory";
import { decodeBarcode, normalizeIsbn } from "@/lib/inventory-scan";

const MAX_QTY = 999;

const PHOTO_HELP =
  "Photo commands: <PIN> [ADD|SET|SOLD] [qty] — e.g. 840071 ADD 3.";

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

  const [pinToken, ...rest] = (
    request.headers.get("x-command-text") ?? ""
  )
    .trim()
    .split(/\s+/);
  if (!pinToken || !secureEqual(pinToken, pin)) return reply("Unauthorized.");

  const command = parseScanCommand(rest);
  if (command === "invalid") return reply(PHOTO_HELP);

  try {
    const image = Buffer.from(await request.arrayBuffer());

    const rawCode = await decodeBarcode(image);
    if (!rawCode) {
      return reply(
        "Couldn't read a barcode from that photo. Try sharper light, fill the frame with the barcode, and keep it flat.",
      );
    }

    const isbn = normalizeIsbn(rawCode);
    if (!isbn) {
      return reply(`Decoded "${rawCode}" but it is not a book ISBN (need EAN-13 starting 978/979).`);
    }

    const db = await getDb();
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

    const logged = await logScan(db, messageId, channelId, isbn);
    if (!logged) return reply("Already processed.");

    const meta = await fetchMetadataByIsbn(isbn);
    if (!meta) {
      return reply(
        `No book found for ISBN ${isbn}. Add it manually with \`npm run books -- add --title "..." --isbn ${isbn}\`.`,
      );
    }

    const stock = command.verb === "SOLD" ? 0 : command.qty;
    const created = await createBook(db, meta, stock);
    return reply(
      `Added "${created.title}" (${created.slug}) from ISBN ${isbn}: stock ${created.stock}. Price unset ($0.00) — set it with \`npm run books -- edit ${created.slug} --price 9.99\`.`,
    );
  } catch (error) {
    console.error("Inventory Discord photo failed", error);
    return new Response("Inventory photo scan failed.", { status: 500 });
  }
}
