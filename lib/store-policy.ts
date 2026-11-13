export const STORE_CURRENCY = "pkr";
// Integer minor units (100 paisa = 1 rupee). Shared by cart and server checkout.
export const SHIPPING_FEE = 25_000;
export const FREE_SHIPPING_AT = 500_000;
export function shippingFor(subtotal: number): number {
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) throw new Error("Invalid subtotal");
  return subtotal === 0 || subtotal >= FREE_SHIPPING_AT ? 0 : SHIPPING_FEE;
}
