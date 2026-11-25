"use client";

import { useEffect, useState } from "react";
import type { listCodFulfillmentOrders } from "@/lib/cod-order";
import type { CodDelivery } from "@/lib/db/schema";
import { formatPrice } from "@/lib/format";
import {CodCashPanel,cashStatus,type CashDetails} from "@/components/cod-cash-panel";

type FulfillmentOrder = Awaited<ReturnType<typeof listCodFulfillmentOrders>>[number];
type Action = "packed" | "shipped" | "delivered" | "cancelled" | "refused" | "returned" | "restock" | "collected" | "remitted";
type ReturnDetails = { itemId: number; qty: number; returnedQty: number };

const labels: Record<string, string> = {
  unfulfilled: "Awaiting packing", packed: "Packed", shipped: "Shipped",
  returning: "Returning to Folio", returned: "Return received", delivered: "Delivered", cancelled: "Cancelled",
};
const actionButton = "rounded-full bg-ink px-4 py-2 text-cream disabled:opacity-50";
const endpoint = "/api/admin/cod/orders";

export function CodOrders({ approvalCount, onStockChanged, onExpired }: {
  approvalCount: number;
  onStockChanged: () => void;
  onExpired: () => void;
}) {
  const [orders, setOrders] = useState<FulfillmentOrder[]>();
  const [refreshCount, setRefreshCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lookupId, setLookupId] = useState<number>();
  const [confirmation, setConfirmation] = useState<{ id: number; action: "cancelled" | "refused" }>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const url = lookupId ? `${endpoint}?id=${lookupId}` : endpoint;
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onExpired(); return; }
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(data.error);
        setOrders(data.orders);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Could not load COD orders.");
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [approvalCount, refreshCount, lookupId, onExpired]);

  async function update(order: FulfillmentOrder, action: Action, details?: ReturnDetails | { tracking: string } | CashDetails) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setConfirmation(undefined);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: order.id, action, fulfillmentStatus: order.fulfillmentStatus, subtotalCents: order.subtotalCents, ...details,
          ...(["collected","remitted"].includes(action)?{status:order.status,totalCents:order.totalCents,collectedAt:order.collectedAt,remittedAt:order.remittedAt}:{}),
        }),
      });
      if (response.status === 401) { onExpired(); return; }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const completed = lookupId === undefined && (action === "cancelled" || action === "remitted");
      setOrders(current => current?.flatMap(entry => {
        if (entry.id !== order.id) return [entry];
        if (completed) return [];
        if(data.order)return [data.order];
        return [{ ...entry, fulfillmentStatus: data.fulfillmentStatus,
          trackingNumber: details && "tracking" in details ? details.tracking.trim() : entry.trackingNumber }];
      }));
      if (action === "returned") setLookupId(order.id);
      setNotice(action === "collected"?`Customer cash collection recorded for order #${order.id}. Courier payout is still pending.`:
        action === "remitted"?`Courier payout recorded for order #${order.id}. Find this order by number to review its cash record.`:
        action === "restock" ? `Inspected copies from order #${order.id} were restocked.` :
        `Order #${order.id} marked ${action}.${action === "cancelled" ? " Its stock was restored." : ""}`);
      if (action === "cancelled" || action === "restock") onStockChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the order.");
    } finally {
      setRefreshCount(value => value + 1);
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-ink/10 bg-white/50 p-5" aria-labelledby="cod-orders-heading">
      <div className="flex items-center justify-between gap-4">
        <h2 id="cod-orders-heading" className="font-display text-2xl">COD fulfillment and cash</h2>
        <button type="button" className="text-sm text-accent underline disabled:opacity-50" disabled={busy}
          onClick={() => { setError(""); setRefreshCount(value => value + 1); }}>
          Refresh orders
        </button>
      </div>
      <form className="mt-4 flex flex-wrap items-end gap-3 text-sm" onSubmit={event => {
        event.preventDefault();
        const id = Number(new FormData(event.currentTarget).get("orderNumber"));
        setError("");
        setOrders(undefined);
        setConfirmation(undefined);
        setLookupId(id);
        setRefreshCount(value => value + 1);
      }}>
        <label>
          Find by order number
          <input name="orderNumber" type="number" min={1} step={1} max={2147483647} required
            className="mt-1 block w-40 rounded border border-ink/20 bg-white p-2" />
        </label>
        <button disabled={busy} className={actionButton}>Find order</button>
        {lookupId !== undefined && <button type="button" disabled={busy} className="text-accent underline"
          onClick={() => { setOrders(undefined); setError(""); setConfirmation(undefined); setLookupId(undefined); }}>
          Back to active orders
        </button>}
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-accent">{notice}</p>}
      {!orders && !error && <p role="status" className="mt-3 text-sm text-ink/60">Loading orders…</p>}
      {orders?.length === 0 && <p className="mt-3 text-sm">{lookupId ? `No COD order found for #${lookupId}.` : "No active COD orders."}</p>}
      {orders?.map(order => {
        const delivery = order.delivery as CodDelivery | null;
        const address = delivery?.address;
        const canRestock = order.fulfillmentStatus === "returned" || order.fulfillmentStatus === "delivered";
        const canCancel = order.fulfillmentStatus === "unfulfilled" || order.fulfillmentStatus === "packed";
        const canRefuse = order.fulfillmentStatus === "shipped";
        return (
          <details key={order.id} open={lookupId === order.id || undefined} className="mt-3 rounded-lg border border-ink/10 p-4 text-sm">
            <summary className="cursor-pointer font-medium">
              Order #{order.id} · {labels[order.fulfillmentStatus]} · {formatPrice(order.totalCents)} · {cashStatus(order)}
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <p>{[delivery?.name, order.phone].filter(Boolean).join(" · ")}</p>
                <p>{[address?.line1, address?.line2, address?.city].filter(Boolean).join(", ")}</p>
              </div>
              <ul className="space-y-3">
                {order.items.map(item => (
                  <li key={item.id}>
                    <p>{item.qty} × {item.title}{item.returnedQty > 0 && ` · ${item.returnedQty} restocked`}</p>
                    {canRestock && item.returnedQty < item.qty && (
                      <form className="mt-1 flex flex-wrap items-end gap-3" onSubmit={event => {
                        event.preventDefault();
                        const qty = Number(new FormData(event.currentTarget).get("qty"));
                        void update(order, "restock", { itemId: item.id, qty, returnedQty: item.returnedQty });
                      }}>
                        <label>
                          Inspected, resellable copies
                          <input name="qty" type="number" required min={1} max={item.qty - item.returnedQty} step={1}
                            key={item.returnedQty} disabled={busy} className="mt-1 block w-24 rounded border border-ink/20 bg-white p-2" />
                        </label>
                        <button disabled={busy} className={actionButton}>Restock copies</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
              <p>Shipping {formatPrice(order.shippingCents)} · {canCancel || canRefuse ? "Collect on delivery" : "Order total"} {formatPrice(order.totalCents)}</p>
              {order.trackingNumber && <p>Tracking number {order.trackingNumber}</p>}
              <CodCashPanel order={order} busy={busy} onRecord={(action,details)=>void update(order,action,details)}/>
              {order.fulfillmentStatus === "packed" && (
                <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
                  event.preventDefault();
                  void update(order, "shipped", { tracking: String(new FormData(event.currentTarget).get("tracking") ?? "") });
                }}>
                  <label className="block">
                    Tracking number
                    <input name="tracking" required disabled={busy}
                      className="mt-1 block rounded border border-ink/20 bg-white p-2" />
                  </label>
                  <button disabled={busy} className={actionButton}>Mark shipped</button>
                </form>
              )}
              {order.fulfillmentStatus === "unfulfilled" && <button type="button" disabled={busy} className={actionButton}
                onClick={() => void update(order, "packed")}>Mark packed</button>}
              {canRefuse && <button type="button" disabled={busy} className={actionButton}
                onClick={() => void update(order, "delivered")}>Mark delivered</button>}
              {order.fulfillmentStatus === "returning" && <button type="button" disabled={busy} className={actionButton}
                onClick={() => void update(order, "returned")}>Mark return received</button>}
              {(canCancel || canRefuse) && (confirmation?.id === order.id ? (
                <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
                  <p>{confirmation.action === "refused" ? "Mark this delivery refused and start tracking the return?" :
                    `Cancel order #${order.id} and return its copies to available stock?`}</p>
                  <div className="flex flex-wrap gap-3">
                    <button type="button" disabled={busy} className="font-medium text-red-700 underline"
                      onClick={() => void update(order, confirmation.action)}>
                      {confirmation.action === "refused" ? "Confirm refusal" : "Confirm cancellation"}
                    </button>
                    <button type="button" onClick={() => setConfirmation(undefined)}>Go back</button>
                  </div>
                </div>
              ) : (
                <button type="button" disabled={busy} className="block text-red-700 underline disabled:opacity-50"
                  onClick={() => setConfirmation({ id: order.id, action: canRefuse ? "refused" : "cancelled" })}>
                  {canRefuse ? "Mark refused" : "Cancel order"}
                </button>
              ))}
            </div>
          </details>
        );
      })}
    </section>
  );
}
