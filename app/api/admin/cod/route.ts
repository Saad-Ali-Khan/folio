import { requestIsAdmin, sameOrigin } from "@/lib/admin-auth";
import { approveCodRequest, pakistaniMobile, pendingCodRequests } from "@/lib/cod-order";
import { getDb } from "@/lib/db";
import { CheckoutError } from "@/lib/order-service";

export async function GET(request: Request) {
  if (!requestIsAdmin(request)) return Response.json({ error: "Unlock inventory to review orders." }, { status: 401 });
  try {
    return Response.json({ requests: await pendingCodRequests(await getDb()) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Could not load COD requests." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  if (!requestIsAdmin(request)) return Response.json({ error: "Unlock inventory to approve orders." }, { status: 401 });
  const input = await request.json().catch(() => null);
  const reference = typeof input?.reference === "string" ? input.reference.trim().toUpperCase() : "";
  const sender = pakistaniMobile(input?.sender);
  if (!/^[A-F0-9]{12}$/.test(reference) || !sender) {
    return Response.json({ error: "Enter the order reference and sender number from WhatsApp." }, { status: 400 });
  }
  try {
    const order = await approveCodRequest(await getDb(), reference, sender);
    return Response.json({ orderId: order.id, totalCents: order.totalCents, addedToExisting: order.checkoutId !== reference });
  } catch (error) {
    if (error instanceof CheckoutError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Could not approve the COD request. Try again." }, { status: 503 });
  }
}
