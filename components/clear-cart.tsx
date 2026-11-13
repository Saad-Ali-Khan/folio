"use client";

import { useEffect } from "react";
import { useCart } from "./cart-provider";
import { writeCheckoutAttempt } from "@/lib/checkout-attempt";

export function ClearCart() {
  const { clear, ready } = useCart();

  useEffect(() => {
    if (ready) {
      clear();
      writeCheckoutAttempt(null);
    }
  }, [ready, clear]);

  return null;
}
