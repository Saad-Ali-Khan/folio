import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { Database } from "./db";
import { requestLimits } from "./db/schema";

export function clientKey(request: Request): string | null {
  if (process.env.NODE_ENV !== "production") return "local";

  // The deployment proxy must overwrite this header and block direct access.
  const header = process.env.TRUSTED_CLIENT_IP_HEADER?.trim();
  const address = header ? request.headers.get(header)?.trim() : undefined;
  if (!address || !isIP(address)) return null;
  return createHash("sha256").update(address).digest("hex");
}

export async function consumeRequestLimit(
  db: Pick<Database, "insert">,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const expires = sql<Date>`now() + (${windowSeconds} * interval '1 second')`;
  const expired = sql`${requestLimits.expiresAt} <= now()`;
  const [entry] = await db.insert(requestLimits).values({ key, count: 1, expiresAt: expires })
    .onConflictDoUpdate({
      target: requestLimits.key,
      set: {
        count: sql`case when ${expired} then 1 else ${requestLimits.count} + 1 end`,
        expiresAt: sql`case when ${expired} then ${expires} else ${requestLimits.expiresAt} end`,
      },
      setWhere: sql`${expired} or ${requestLimits.count} < ${limit}`,
    }).returning({ key: requestLimits.key });
  return Boolean(entry);
}
