const storageKey = "folio.checkout-attempt";
export type CheckoutAttempt = { id: string; cart: string; expiresAt: number };

export function readCheckoutAttempt(): CheckoutAttempt | null {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as CheckoutAttempt | null;
    return attempt && typeof attempt.id === "string" && typeof attempt.cart === "string" &&
      attempt.expiresAt > Date.now() ? attempt : null;
  } catch {
    return null;
  }
}

export function writeCheckoutAttempt(attempt: CheckoutAttempt | null) {
  try {
    if (attempt) sessionStorage.setItem(storageKey, JSON.stringify(attempt));
    else sessionStorage.removeItem(storageKey);
  } catch {
    // The current cart can still retry using React state if storage is blocked.
  }
}
