import { getDb } from "@/lib/db";
import { secureEqual } from "@/lib/discord-inventory";
import { readRetainedCover } from "@/lib/pending-covers";

export async function GET(request: Request) {
  const secret = process.env.INVENTORY_DISCORD_SECRET?.trim();
  if (!secret || !secureEqual(request.headers.get("x-inventory-secret") ?? "", secret)) return new Response(null, { status: 401 });
  const channel = request.headers.get("x-channel-id") ?? "", user = request.headers.get("x-user-id") ?? "";
  if (channel !== process.env.DISCORD_CHANNEL_ID?.trim() || !user) return new Response(null, { status: 403 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[a-f0-9]{20}$/.test(id)) return new Response(null, { status: 400 });
  try {
    const data = await readRetainedCover(await getDb(), id, user, channel);
    return new Response(new Uint8Array(data), { headers: { "Content-Type": "image/webp", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } }); }
}
