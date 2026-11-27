export function formatPrice(cents: number, currency = "PKR"): string {
 const code=currency.toUpperCase();
 // Currency defaults differ between browser/ICU versions. Preserve actual PKR
 // subunits in cash receipts while keeping whole-rupee prices uncluttered.
 return new Intl.NumberFormat("en-PK", {style:"currency", currency:code,
  ...(code==="PKR"?{minimumFractionDigits:cents%100===0?0:2,maximumFractionDigits:2}:{})}).format(cents / 100);
}
