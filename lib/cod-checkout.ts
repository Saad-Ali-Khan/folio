import { createHash } from "node:crypto";
import { requestIsAdmin, sameOrigin } from "@/lib/admin-auth";
import { codWhatsAppNumber, pakistaniMobile, createCodRequest, quoteCodRequest } from "@/lib/cod-order";
import { codStatusToken } from "@/lib/cod-request-status";
import { getDb } from "@/lib/db";
import { CheckoutError } from "@/lib/order-service";
import { clientKey, consumeRequestLimit } from "@/lib/request-limits";
import { sendWhatsAppTest, whatsAppTestConfig } from "@/lib/whatsapp-test";

const headers = { "Cache-Control": "no-store" };

function parseItems(items: unknown) {
  if (!Array.isArray(items) || !items.length || items.length > 50) return null;
  const parsed = new Map<number, number>();
  for (const item of items) {
    if (!item || !Number.isInteger(item.id) || item.id < 1 || item.id > 2147483647 ||
        !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 10) return null;
    const quantity = (parsed.get(item.id) ?? 0) + item.qty;
    if (quantity > 10) return null;
    parsed.set(item.id, quantity);
  }
  return Array.from(parsed, ([id, qty]) => ({ id, qty }));
}

function field(value: unknown, min: number, max: number) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length >= min ? trimmed : null;
}

export async function submitCodCheckout(request: Request, whatsappTest = false) {
  const client = clientKey(request);
  if (!client || !sameOrigin(request)) return Response.json({ error: "Checkout request could not be verified." }, { status: 403 });
  if (whatsappTest && !requestIsAdmin(request)) {
    return Response.json({ error: "Sign in to admin again to run a checkout test." }, { status: 401, headers });
  }
  const whatsappNumber = codWhatsAppNumber();
  if (!whatsappNumber) {
    return Response.json({ error: "Cash on delivery is currently unavailable." }, { status: 503 });
  }

  const input = await request.json().catch(() => null);
  const phone = pakistaniMobile(input?.phone);
  const name = field(input?.name, 2, 120);
  const line1 = field(input?.line1, 8, 200);
  const line2 = field(input?.line2 ?? "", 0, 200);
  const city = field(input?.city, 2, 80);
  const items = parseItems(input?.items);
  if (!phone || !name || !line1 || line2 === null || !city || !items) {
    return Response.json({ error: "Enter a Pakistani mobile number, street address, and delivery city in Pakistan." }, { status: 400 });
  }
  const total = input.totalCents;
  if (!Number.isSafeInteger(total) || total < 1) {
    return Response.json({ error: "Review the order total and try again." }, { status: 422 });
  }

  const phoneKey = createHash("sha256").update(phone).digest("hex");
  try {
    if (whatsappTest) {
      const config = whatsAppTestConfig();
      if (!config) throw new CheckoutError("WhatsApp test messaging is unconfigured.", 503);
      if (phone.slice(1) !== config.recipient) {
        throw new CheckoutError("Enter the Pakistani WhatsApp number configured as the test recipient.", 400);
      }
      const db = await getDb();
      await quoteCodRequest(db, items, total);
      const cart = items.sort((a, b) => a.id - b.id);
      const cartKey = createHash("sha256").update(JSON.stringify({ cart, total })).digest("hex");
      // Claim the send before calling Meta, since a timed-out response can still deliver.
      if (!await consumeRequestLimit(db, `cod:whatsapp-test:${phoneKey}:${cartKey}`, 1, 900)) {
        throw new CheckoutError("A test send was already attempted for this cart. Check WhatsApp or retry in 15 minutes.", 429);
      }
      const result = await sendWhatsAppTest(config);
      return Response.json({ ...result, whatsappTest: true }, { status: result.accepted ? 200 : 502, headers });
    }
    const db = await getDb();
    if (!await consumeRequestLimit(db, `cod:request:ip:${client}`, 15, 900) ||
        !await consumeRequestLimit(db, `cod:request:phone:${phoneKey}`, 5, 900)) {
      throw new CheckoutError("Too many checkout requests. Try again later.", 429);
    }
    const pending = await createCodRequest(db, phone, { name, address: { line1, line2, city, country: "PK" } }, items, total);
    const message = encodeURIComponent(`I'd like to confirm Folio order request ${pending.id}.`);
    return Response.json({
      reference: pending.id,
      totalCents: pending.totalCents,
      whatsappUrl: `https://wa.me/${whatsappNumber}?text=${message}`,
      statusToken: codStatusToken(pending.id),
    }, { headers });
  } catch (error) {
    if (error instanceof CheckoutError) return Response.json({ error: error.message }, { status: error.status });
    // Database errors can include query parameters containing customer details.
    const cause = error instanceof Error ? error.cause : undefined;
    const details = cause ?? error;
    const code = details && typeof details === "object" && "code" in details &&
      typeof details.code === "string" && /^[A-Z0-9_]{5,32}$/.test(details.code) ? details.code : undefined;
    console.error(`COD checkout failed (${code ?? "no error code"})`);
    return Response.json({ error: "Cash on delivery could not be completed. Please try again." }, { status: 503 });
  }
}
