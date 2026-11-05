"use client";

import { useEffect } from "react";
import { useCart } from "./cart-provider";

export function ClearCart() {
  const { clear, ready } = useCart();

  useEffect(() => {
    if (ready) clear();
  }, [ready, clear]);

  return null;
}
