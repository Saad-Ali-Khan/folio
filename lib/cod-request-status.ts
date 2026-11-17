import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, or, sql } from "drizzle-orm";
import type { Database } from "./db";
import { codRequests, orders } from "./db/schema";

export function codStatusToken(reference: string): string | null {
  const secret = process.env.ADMIN_SESSION_SECRET ||
    (process.env.NODE_ENV === "production" ? undefined : process.env.INVENTORY_DISCORD_SECRET);
  return secret ? createHmac("sha256", secret).update(`cod-status:${reference}`).digest("hex") : null;
}

export function validCodStatusToken(reference: unknown, token: unknown): reference is string {
  if (typeof reference !== "string" || !/^[A-F0-9]{12}$/.test(reference) ||
      typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
  const expected = codStatusToken(reference);
  return expected !== null && timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
}

export async function codRequestStatus(db: Database, reference: string) {
  const [entry] = await db.select({ status: orders.status, expiresAt: codRequests.expiresAt })
    .from(sql`(select ${reference}::text as reference) as checkout`)
    .leftJoin(codRequests, eq(codRequests.id, sql`checkout.reference`))
    .leftJoin(orders, or(eq(orders.id, codRequests.orderId), eq(orders.checkoutId, sql`checkout.reference`)));
  if (entry?.status) return entry.status === "void" ? "closed" : "approved";
  if (entry?.expiresAt && entry.expiresAt.getTime() > Date.now()) return "pending";
  return "closed";
}
