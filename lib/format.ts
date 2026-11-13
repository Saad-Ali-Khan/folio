export function formatPrice(cents: number, currency = "PKR"): string {
 return new Intl.NumberFormat("en-PK", {style:"currency", currency:currency.toUpperCase()}).format(cents / 100);
}
