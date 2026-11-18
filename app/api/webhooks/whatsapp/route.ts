import { createHmac, timingSafeEqual } from "node:crypto";

const headers = { "Cache-Control": "no-store" };
const maxTestPayloadBytes = 1_048_576;

export function GET(request: Request) {
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!expected) return new Response(null, { status: 503, headers });
  const query = new URL(request.url).searchParams;
  const challenge = query.get("hub.challenge");
  const supplied = Buffer.from(query.get("hub.verify_token") ?? "");
  const token = Buffer.from(expected);
  if (query.get("hub.mode") !== "subscribe" || !challenge ||
      supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
    return new Response(null, { status: 403, headers });
  }
  return new Response(challenge, { headers });
}

export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) return new Response(null, { status: 503, headers });
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) {
    return new Response(null, { status: 403, headers });
  }

  // Bound buffering before authentication, and verify the original bytes.
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400, headers });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxTestPayloadBytes) {
        await reader.cancel();
        return new Response(null, { status: 413, headers });
      }
      chunks.push(value);
    }
  } catch {
    return new Response(null, { status: 400, headers });
  } finally {
    reader.releaseLock();
  }
  const payload = Buffer.concat(chunks, size);
  const digest = createHmac("sha256", secret).update(payload).digest();
  if (!timingSafeEqual(Buffer.from(signature.slice(7), "hex"), digest)) {
    return new Response(null, { status: 403, headers });
  }

  try {
    const event = JSON.parse(payload.toString("utf8"));
    if (event?.object !== "whatsapp_business_account" || !Array.isArray(event.entry)) {
      return new Response(null, { status: 400, headers });
    }
    console.info("Verified WhatsApp test webhook");
    return Response.json({ received: true }, { headers });
  } catch {
    return new Response(null, { status: 400, headers });
  }
}
