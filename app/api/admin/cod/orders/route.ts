import { requestIsAdmin, sameOrigin } from "@/lib/admin-auth";
import { cancelCodOrder, listCodFulfillmentOrders, recordCodEvent, type CodCashSnapshot } from "@/lib/cod-order";
import {parseCodCash} from "@/lib/cod-cash";
import { getDb } from "@/lib/db";
import { advanceFulfillment, CheckoutError, returnItem } from "@/lib/order-service";

const noStore = { "Cache-Control": "no-store" };
const maxInteger = 2_147_483_647;

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maxInteger;
}

function cashTimestamp(value:unknown):value is string|null {
  return value===null || typeof value==="string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
}

export async function GET(request: Request) {
  if (!requestIsAdmin(request)) return Response.json({ error: "Unlock inventory to view orders." }, { status: 401, headers: noStore });
  const query = new URL(request.url).searchParams.get("id");
  const id = query === null ? undefined : Number(query);
  if (id !== undefined && !positiveInteger(id)) {
    return Response.json({ error: "Enter a valid order number." }, { status: 400, headers: noStore });
  }
  try {
    return Response.json({ orders: await listCodFulfillmentOrders(await getDb(), id) }, { headers: noStore });
  } catch {
    return Response.json({ error: "Could not load COD orders." }, { status: 503, headers: noStore });
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  if (!requestIsAdmin(request)) return Response.json({ error: "Unlock inventory to update orders." }, { status: 401 });

  const input = await request.json().catch(() => null);
  const { id, action, fulfillmentStatus, subtotalCents } = input ?? {};
  const tracking = typeof input?.tracking === "string" ? input.tracking.trim() : "";
  if (!positiveInteger(id) ||
      !["packed", "shipped", "delivered", "cancelled", "refused", "returned", "restock", "collected", "remitted"].includes(action) ||
      !["unfulfilled", "packed", "shipped", "returning", "returned", "delivered"].includes(fulfillmentStatus) ||
      !Number.isInteger(subtotalCents) || subtotalCents < 0 || subtotalCents > maxInteger) {
    return Response.json({ error: "Refresh the order and choose a valid action." }, { status: 400 });
  }
  if (action === "shipped" && !tracking) {
    return Response.json({ error: "Enter a tracking number." }, { status: 400 });
  }

  try {
    const db = await getDb();
    const expected = { fulfillmentStatus, subtotalCents };
    if(action==="collected" || action==="remitted") {
      const amount=parseCodCash(input.amount),reference=typeof input.reference==="string"?input.reference.trim():"";
      if(amount===null || !Number.isInteger(input.totalCents) || input.totalCents<0 || input.totalCents>maxInteger ||
        !["cash_due","paid"].includes(input.status) || !cashTimestamp(input.collectedAt) || !cashTimestamp(input.remittedAt) ||
        (action==="remitted" && (!reference || reference.length>200 || /[\p{Cc}\p{Cf}]/u.test(reference))))
        return Response.json({error:"Enter a valid PKR amount and courier reference, then refresh if the cash record changed."},{status:400});
      const snapshot:CodCashSnapshot={...expected,totalCents:input.totalCents,status:input.status,collectedAt:input.collectedAt,remittedAt:input.remittedAt};
      await recordCodEvent(db,id,`cod-${action}`,amount,reference,snapshot);
      return Response.json({fulfillmentStatus,order:(await listCodFulfillmentOrders(db,id))[0]},{headers:noStore});
    }
    if (action === "restock") {
      const { itemId, qty, returnedQty } = input;
      if (!positiveInteger(itemId) || !positiveInteger(qty) ||
          !Number.isInteger(returnedQty) || returnedQty < 0 || returnedQty > maxInteger) {
        return Response.json({ error: "Enter the number of inspected, resellable copies." }, { status: 400 });
      }
      // The displayed count makes retries safe after a lost response.
      const reference = `admin-cod-return:${id}:${itemId}:${returnedQty}`;
      await returnItem(db, id, itemId, qty, reference, { ...expected, returnedQty });
    } else if (action === "refused" || action === "returned") await recordCodEvent(db, id, `cod-${action}`);
    else if (action === "cancelled") await cancelCodOrder(db, id, expected);
    else await advanceFulfillment(db, id, action, tracking, expected);
    return Response.json({ fulfillmentStatus: action === "refused" ? "returning" : action === "restock" ? fulfillmentStatus : action }, { headers: noStore });
  } catch (error) {
    if (error instanceof CheckoutError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Could not update the order. Refresh orders before retrying." }, { status: 503 });
  }
}
