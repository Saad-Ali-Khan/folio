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
  const [rawVerb, rawIdentifier, rawQty] = tokens;
  const verb = rawVerb?.toUpperCase();
  if (!verb || !rawIdentifier) return null;

  if (verb === "GET") {
    return { verb, identifier: rawIdentifier, qty: null };
  }

  if (verb !== "SET" && verb !== "ADD" && verb !== "SOLD") return null;

  const qty = Number(rawQty);
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_QTY) return null;
  if ((verb === "ADD" || verb === "SOLD") && qty < 1) return null;

  return { verb, identifier: rawIdentifier, qty };
}
