export type InventoryVerb = "SET" | "ADD" | "SOLD" | "GET";

export type InventoryCommand = {
  verb: InventoryVerb;
  identifier: string;
  qty: number | null;
};

export const INVENTORY_HELP =
  "Folio inventory: SET <slug> <qty>, ADD <slug> <n>, SOLD <slug> <n>, GET <slug>. Prefix every message with your PIN.";

const MAX_QTY = 1_000_000;

export function parseInventoryCommand(
  tokens: string[],
): InventoryCommand | null {
  const [rawVerb, ...rest] = tokens;
  const verb = rawVerb?.toUpperCase();
  if (!verb || rest.length === 0) return null;

  if (verb === "GET") {
    const identifier = rest.join(" ").trim();
    if (!identifier) return null;
    return { verb, identifier, qty: null };
  }

  if (verb !== "SET" && verb !== "ADD" && verb !== "SOLD") return null;

  // The quantity is the last token; the identifier may span the tokens in
  // between so multi-word titles like "east of eden" work.
  const qty = Number(rest.at(-1));
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) return null;
  if ((verb === "ADD" || verb === "SOLD") && qty < 1) return null;

  const identifier = rest.slice(0, -1).join(" ").trim();
  if (!identifier) return null;

  return { verb, identifier, qty };
}
