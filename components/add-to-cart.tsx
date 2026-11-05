"use client";

import { useState } from "react";
import { useCart, type CartItem } from "./cart-provider";

type AddToCartButtonProps = {
  book: Omit<CartItem, "qty">;
  disabled?: boolean;
  label?: string;
  className?: string;
};

export function AddToCartButton({
  book,
  disabled = false,
  label = "Add to cart",
  className = "",
}: AddToCartButtonProps) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-live="polite"
      onClick={() => {
        add(book);
        setAdded(true);
        window.setTimeout(() => setAdded(false), 1600);
      }}
      className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
        disabled
          ? "cursor-not-allowed bg-ink/10 text-ink/40"
          : "bg-ink text-cream hover:bg-accent"
      } ${className}`}
    >
      {disabled ? "Sold out" : added ? "Added" : label}
    </button>
  );
}
