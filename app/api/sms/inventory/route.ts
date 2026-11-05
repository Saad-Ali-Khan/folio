import { timingSafeEqual } from "node:crypto";
import { eq, or, sql } from "drizzle-orm";
import twilio from "twilio";
import { getDb } from "@/lib/db";
import { books, smsCommands } from "@/lib/db/schema";
import {
  INVENTORY_HELP,
  parseInventoryCommand,
} from "@/lib/inventory-command";

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeXml(value: string) {
  const entities: Record<string, string> = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  };
  return value.replace(/[<>&'"]/g, (char) => entities[char] ?? char);
}

function reply(message?: string) {
  const body = message
    ? `<Response><Message>${escapeXml(message)}</Message></Response>`
    : "<Response></Response>";
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const allowedFrom = normalizePhone(process.env.INVENTORY_SMS_FROM ?? "");
  const pin = process.env.INVENTORY_SMS_PIN?.trim();

  if (!authToken || !allowedFrom || !pin) {
    return new Response("SMS inventory is not configured.", { status: 503 });
  }

  const signature = request.headers.get("x-twilio-signature");
  if (!signature) {
    return new Response("Missing signature.", { status: 403 });
  }

  let params: Record<string, string>;
  try {
    const form = await request.formData();
    params = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") params[key] = value;
    }
  } catch {
    return new Response("Expected a form-encoded body.", { status: 400 });
  }

  const urls = new Set([
    new URL("/api/sms/inventory", request.url).toString(),
  ]);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (appUrl) {
    urls.add(new URL("/api/sms/inventory", appUrl).toString());
  }

  const signatureValid = [...urls].some((url) =>
    twilio.validateRequest(authToken, signature, url, params),
  );
  if (!signatureValid) {
    console.error("Invalid Twilio signature for inventory SMS");
    return new Response("Invalid signature.", { status: 403 });
  }

  const from = normalizePhone(params.From ?? "");
  if (from !== allowedFrom) {
    console.warn(
      `Ignoring inventory SMS from unrecognized number ${from || "(unknown)"}`,
    );
    return reply();
  }

  const messageSid = params.MessageSid?.trim();
  if (!messageSid) {
    return new Response("Missing MessageSid.", { status: 400 });
  }

  const body = (params.Body ?? "").trim();
  if (!body) return reply(INVENTORY_HELP);
  if (body.length > 160) return reply("Message too long.");

  const tokens = body.split(/\s+/);
  if (!secureEqual(tokens[0] ?? "", pin)) {
    return reply("Unauthorized.");
  }

  const command = parseInventoryCommand(tokens.slice(1));
  if (!command) return reply(INVENTORY_HELP);

  const identifier = command.identifier.trim();

  try {
    const db = await getDb();
    const [book] = await db
      .select()
      .from(books)
      .where(
        or(
          eq(books.slug, identifier.toLowerCase()),
          eq(books.isbn, identifier.replace(/[-\s]/g, "")),
        ),
      )
      .limit(1);

    if (!book) {
      return reply(`No book matches "${identifier}".`);
    }

    if (command.verb === "GET") {
      return reply(`${book.title} (${book.slug}): ${book.stock} in stock.`);
    }

    const qty = command.qty ?? 0;
    const summary = `${command.verb} ${book.slug} ${qty}`;

    const outcome = await db.transaction(async (tx) => {
      const [logged] = await tx
        .insert(smsCommands)
        .values({ messageSid, fromNumber: from, command: summary })
        .onConflictDoNothing({ target: smsCommands.messageSid })
        .returning({ id: smsCommands.id });

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

    if (outcome.duplicate) {
      return reply("Already processed.");
    }

    return reply(`OK ${book.slug}: stock ${outcome.stock} (was ${book.stock}).`);
  } catch (error) {
    console.error("Inventory SMS update failed", error);
    return new Response("Inventory update failed.", { status: 500 });
  }
}
