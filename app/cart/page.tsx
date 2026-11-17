import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { CartView } from "@/components/cart-view";
import { codWhatsAppNumber } from "@/lib/cod-order";

export const metadata: Metadata = {
  title: "Cart",
};

async function CheckoutCart() {
  await connection();
  return <CartView checkoutEnabled={Boolean(codWhatsAppNumber())} />;
}

export default function CartPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-4xl">Your cart</h1>
      <div className="mt-8">
        <Suspense fallback={<p role="status">Loading your cart…</p>}>
          <CheckoutCart />
        </Suspense>
      </div>
    </div>
  );
}
