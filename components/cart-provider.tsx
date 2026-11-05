"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type CartItem = {
  id: number;
  slug: string;
  title: string;
  author: string;
  priceCents: number;
  coverUrl: string | null;
  qty: number;
};

type CartContextValue = {
  items: CartItem[];
  ready: boolean;
  count: number;
  add: (book: Omit<CartItem, "qty">, qty?: number) => void;
  setQty: (id: number, qty: number) => void;
  remove: (id: number) => void;
  clear: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

const STORAGE_KEY = "folio.cart.v1";
const CHANGE_EVENT = "folio:cart-change";
const MAX_QTY = 10;
const EMPTY_CART: CartItem[] = [];

function isCartItem(value: unknown): value is CartItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<CartItem>;
  return (
    typeof item.id === "number" &&
    typeof item.slug === "string" &&
    typeof item.title === "string" &&
    typeof item.author === "string" &&
    typeof item.priceCents === "number" &&
    (typeof item.coverUrl === "string" || item.coverUrl === null) &&
    typeof item.qty === "number" &&
    item.qty > 0
  );
}

function parseCart(raw: string | null): CartItem[] {
  if (!raw) return EMPTY_CART;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCartItem) : EMPTY_CART;
  } catch {
    return EMPTY_CART;
  }
}

let cache: { raw: string | null; items: CartItem[] } = {
  raw: null,
  items: EMPTY_CART,
};

function getSnapshot(): CartItem[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY_CART;
  }
  if (raw === cache.raw) return cache.items;
  const items = parseCart(raw);
  cache = { raw, items };
  return items;
}

function getServerSnapshot(): CartItem[] {
  return EMPTY_CART;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

function writeCart(items: CartItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function clampQty(qty: number): number {
  return Math.min(Math.max(Math.trunc(qty), 1), MAX_QTY);
}

function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

function emptySubscribe(): () => void {
  return () => {};
}

export function CartProvider({ children }: { children: ReactNode }) {
  const items = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const ready = useHydrated();

  const add = useCallback((book: Omit<CartItem, "qty">, qty = 1) => {
    const current = getSnapshot();
    const existing = current.find((item) => item.id === book.id);
    const next = existing
      ? current.map((item) =>
          item.id === book.id
            ? { ...item, qty: clampQty(item.qty + qty) }
            : item,
        )
      : [...current, { ...book, qty: clampQty(qty) }];
    writeCart(next);
  }, []);

  const setQty = useCallback((id: number, qty: number) => {
    writeCart(
      getSnapshot().map((item) =>
        item.id === id ? { ...item, qty: clampQty(qty) } : item,
      ),
    );
  }, []);

  const remove = useCallback((id: number) => {
    writeCart(getSnapshot().filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    writeCart([]);
  }, []);

  const count = useMemo(
    () => items.reduce((sum, item) => sum + item.qty, 0),
    [items],
  );

  const value = useMemo(
    () => ({ items, ready, count, add, setQty, remove, clear }),
    [items, ready, count, add, setQty, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart must be used inside CartProvider");
  }
  return context;
}
