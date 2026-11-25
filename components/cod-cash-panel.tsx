"use client";

import {formatPrice} from "@/lib/format";

export type CashOrder={id:number;fulfillmentStatus:string;status:string;totalCents:number;collectedAt:string|Date|null;
  remittedAt:string|Date|null;remittedCents:number|null;remittanceReference:string|null};
export type CashDetails={amount:string;reference?:string};
export function cashStatus(order:CashOrder) {
  if(order.remittedAt)return "Payout received by Folio";
  if(order.collectedAt)return "Customer paid · awaiting courier payout";
  if(order.status==="void")return "No cash due";
  return order.fulfillmentStatus==="delivered"?"Awaiting cash collection confirmation":"Cash due on delivery";
}
const field="mt-1 block rounded border border-ink/20 bg-white p-2";
const button="rounded-full bg-ink px-4 py-2 text-cream disabled:opacity-50";
const date=(value:string|Date)=>new Date(value).toLocaleString();

export function CodCashPanel({order,busy,onRecord}:{order:CashOrder;busy:boolean;onRecord:(action:"collected"|"remitted",details:CashDetails)=>void}) {
  const canCollect=order.fulfillmentStatus==="delivered"&&order.status==="cash_due"&&!order.collectedAt;
  const canRemit=order.fulfillmentStatus==="delivered"&&order.status==="paid"&&Boolean(order.collectedAt)&&!order.remittedAt;
  return <section className="space-y-3 rounded-lg border border-ink/10 bg-parchment/40 p-4" aria-label={`Cash record for order ${order.id}`}>
    <h3 className="font-medium">Cash and courier payout</h3>
    <p className="text-accent">{cashStatus(order)}</p>
    {order.collectedAt&&<p>Courier collected {formatPrice(order.totalCents)} from the customer · {date(order.collectedAt)}</p>}
    {order.remittedAt&&order.remittedCents!==null&&<div className="space-y-1">
      <p>Folio received {formatPrice(order.remittedCents)} · {date(order.remittedAt)}</p>
      <p>Courier statement: {order.remittanceReference}</p>
      <p>Difference from customer payment: {formatPrice(order.totalCents-order.remittedCents)}</p>
    </div>}
    {canCollect&&<form className="space-y-3" onSubmit={event=>{
      event.preventDefault();onRecord("collected",{amount:String(new FormData(event.currentTarget).get("amount")??"")});
    }}>
      <p className="text-ink/60">Check the courier record before confirming. The collected amount must match the order total: {formatPrice(order.totalCents)}.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label>Cash collected · PKR<input name="amount" type="number" required min="0" max="21474836.47" step="0.01"
          defaultValue={(order.totalCents/100).toFixed(2)} disabled={busy} className={`${field} w-44`}/></label>
        <button disabled={busy} className={button}>Record cash collected</button>
      </div>
    </form>}
    {canRemit&&<form className="space-y-3" onSubmit={event=>{
      event.preventDefault();const data=new FormData(event.currentTarget);
      onRecord("remitted",{amount:String(data.get("amount")??""),reference:String(data.get("reference")??"")});
    }}>
      <p className="text-ink/60">Record the net amount actually received by Folio and the courier statement reference. This records a payout; it does not transfer money.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label>Net payout received · PKR<input name="amount" type="number" required min="0" max={(order.totalCents/100).toFixed(2)} step="0.01"
          disabled={busy} className={`${field} w-44`}/></label>
        <label>Courier statement reference<input name="reference" required maxLength={200} disabled={busy} className={field}/></label>
        <button disabled={busy} className={button}>Record courier payout</button>
      </div>
    </form>}
  </section>;
}
