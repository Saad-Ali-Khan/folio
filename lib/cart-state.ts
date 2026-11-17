export type CartItem = {
  id: number;
  slug: string;
  title: string;
  author: string;
  priceCents: number;
  coverUrl: string | null;
  qty: number;
};

export type CartLine = CartItem & { copyIds: string[] };
export type TrackedCodRequest = { reference: string; token: string; copyIds: string[] };
export type CartState = { items: CartLine[]; requests: TrackedCodRequest[] };

const MAX_QTY = 10;
export const EMPTY_CART: CartState = { items: [], requests: [] };

function isCartItem(value: unknown): value is CartItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<CartItem>;
  return typeof item.id === "number" && typeof item.slug === "string" &&
    typeof item.title === "string" && typeof item.author === "string" &&
    typeof item.priceCents === "number" && (typeof item.coverUrl === "string" || item.coverUrl === null) &&
    typeof item.qty === "number" && Number.isInteger(item.qty) && item.qty > 0;
}

function isTrackedRequest(value: unknown): value is TrackedCodRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<TrackedCodRequest>;
  return typeof request.reference === "string" && /^[A-F0-9]{12}$/.test(request.reference) &&
    typeof request.token === "string" && /^[a-f0-9]{64}$/.test(request.token) &&
    Array.isArray(request.copyIds) && request.copyIds.every(id => typeof id === "string");
}

export function parseCart(raw: string | null): CartState {
  if (!raw) return EMPTY_CART;
  try {
    const data = JSON.parse(raw);
    const items = Array.isArray(data) ? data : data?.items;
    if (!Array.isArray(items)) return EMPTY_CART;
    return {
      items: items.filter(isCartItem).map((item: CartItem & { copyIds?: unknown }) => {
        const qty = Math.min(item.qty, MAX_QTY);
        const copyIds = Array.isArray(item.copyIds) && item.copyIds.length === qty &&
          item.copyIds.every(id => typeof id === "string") ? item.copyIds :
          Array.from({ length: qty }, (_, index) => `legacy:${item.id}:${index}`);
        return { ...item, qty, copyIds };
      }),
      requests: Array.isArray(data.requests) ? data.requests.filter(isTrackedRequest) : [],
    };
  } catch {
    return EMPTY_CART;
  }
}

export function resizeCartLine(line: CartLine, quantity: number): CartLine {
  const qty = Math.min(Math.max(Math.trunc(quantity), 1), MAX_QTY);
  const copyIds = line.copyIds.slice(0, qty);
  while (copyIds.length < qty) copyIds.push(crypto.getRandomValues(new Uint32Array(4)).join("-"));
  return { ...line, qty, copyIds };
}

export function resolveCartRequest(state: CartState, reference: string, approved: boolean): CartState {
  const request = state.requests.find(entry => entry.reference === reference);
  if (!request) return state;
  const requests = state.requests.filter(entry => entry !== request);
  if (!approved) return { ...state, requests };

  const purchased = new Set(request.copyIds);
  const items = state.items.flatMap(item => {
    const copyIds = item.copyIds.filter(id => !purchased.has(id));
    return copyIds.length ? [{ ...item, qty: copyIds.length, copyIds }] : [];
  });
  return { items, requests };
}
