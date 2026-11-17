"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  EMPTY_CART, parseCart, resizeCartLine, resolveCartRequest,
  type CartItem, type CartLine, type CartState, type TrackedCodRequest,
} from "@/lib/cart-state";

export type { CartItem } from "@/lib/cart-state";

type CartContextValue = {
  items: CartLine[];
  ready: boolean;
  count: number;
  approvedReference: string | null;
  add: (book: Omit<CartItem, "qty">, qty?: number) => void;
  setQty: (id: number, qty: number) => void;
  remove: (id: number) => void;
  clear: () => void;
  trackCodRequest: (request: TrackedCodRequest) => Promise<void>;
};

const CartContext = createContext<CartContextValue | null>(null);

const STORAGE_KEY = "folio.cart.v1";
const CHANGE_EVENT = "folio:cart-change";

let cache: { raw: string | null; state: CartState } = {
  raw: null,
  state: EMPTY_CART,
};

function getSnapshot(): CartState {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY_CART;
  }
  if (raw === cache.raw) return cache.state;
  const state = parseCart(raw);
  cache = { raw, state };
  return state;
}

function getServerSnapshot(): CartState {
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

async function mutateCart(update: (state: CartState) => CartState): Promise<boolean> {
  function commit() {
    const current = getSnapshot();
    const next = update(current);
    if (next === current) return false;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      return false;
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return true;
  }

  // Serialize edits and approval reconciliation across tabs when supported.
  return navigator.locks ? navigator.locks.request(STORAGE_KEY, commit) : commit();
}

async function checkRequest({ reference, token }: TrackedCodRequest, signal: AbortSignal) {
  const response = await fetch("/api/checkout/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference, token }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status === 404) return "closed";
  if (!response.ok) return "pending";
  const result: { status?: unknown } | null = await response.json();
  return result?.status;
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
  const { items } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const ready = useHydrated();
  const [approvedReference, setApprovedReference] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;

    async function reconcile() {
      if (checking || document.hidden) return;
      const { requests } = getSnapshot();
      if (!requests.length) return;
      checking = true;
      try {
        await Promise.allSettled(requests.map(async request => {
          const status = await checkRequest(request, controller.signal);
          if (controller.signal.aborted || (status !== "approved" && status !== "closed")) return;
          const applied = await mutateCart(state => resolveCartRequest(state, request.reference, status === "approved"));
          if (applied && status === "approved" && !controller.signal.aborted) setApprovedReference(request.reference);
        }));
      } finally {
        checking = false;
      }
    }

    void reconcile();
    const timer = window.setInterval(reconcile, 15_000);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, []);

  const add = useCallback((book: Omit<CartItem, "qty">, qty = 1) => {
    void mutateCart(state => {
      const existing = state.items.find(item => item.id === book.id);
      const items = existing
        ? state.items.map(item => item === existing ? resizeCartLine(item, item.qty + qty) : item)
        : [...state.items, resizeCartLine({ ...book, qty: 0, copyIds: [] }, qty)];
      return { ...state, items };
    });
  }, []);

  const setQty = useCallback((id: number, qty: number) => {
    void mutateCart(state => ({
      ...state,
      items: state.items.map(item => item.id === id ? resizeCartLine(item, qty) : item),
    }));
  }, []);

  const remove = useCallback((id: number) => {
    void mutateCart(state => ({ ...state, items: state.items.filter(item => item.id !== id) }));
  }, []);

  const clear = useCallback(() => {
    void mutateCart(state => ({ ...state, items: [] }));
  }, []);

  const trackCodRequest = useCallback(async (request: TrackedCodRequest) => {
    await mutateCart(state => ({
      ...state,
      requests: [...state.requests.filter(entry => entry.reference !== request.reference), request],
    }));
  }, []);

  const count = useMemo(
    () => items.reduce((sum, item) => sum + item.qty, 0),
    [items],
  );

  const value = useMemo(
    () => ({ items, ready, count, approvedReference, add, setQty, remove, clear, trackCodRequest }),
    [items, ready, count, approvedReference, add, setQty, remove, clear, trackCodRequest],
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
