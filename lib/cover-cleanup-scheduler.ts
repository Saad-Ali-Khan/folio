import { isNull } from "drizzle-orm";
import type { Database } from "./db";
import { pendingCovers } from "./db/schema";
import { cleanupRetainedCovers } from "./pending-covers";

/** Sleeps until known expiry; one startup scan, no periodic empty-table polling. */
export function createCoverCleanupScheduler(database: () => Promise<Database>, log: (line:string)=>void) {
  let timer: ReturnType<typeof setTimeout> | undefined, due = Infinity, stopped = false;
  function schedule(at: number) {
    if (stopped || !Number.isFinite(at) || at >= due) return;
    if (timer) clearTimeout(timer);
    due = at;
    timer = setTimeout(() => { timer=undefined;due=Infinity;void run(); }, Math.max(500, Math.min(2_000_000_000, at-Date.now())));
  }
  async function run() {
    try {
      const db = await database();
      const count = await cleanupRetainedCovers(db);
      if(count) log(`Expired retained-cover objects removed: ${count}.`);
      const [next] = await db.select({expiresAt:pendingCovers.expiresAt}).from(pendingCovers).where(isNull(pendingCovers.cleanedAt)).orderBy(pendingCovers.expiresAt).limit(1);
      if(next) schedule(next.expiresAt.getTime());
    } catch { log("Retained-cover cleanup deferred; retrying in ten minutes."); schedule(Date.now()+600_000); }
  }
  return { start: run, schedule, stop() { stopped=true;if(timer)clearTimeout(timer); } };
}
