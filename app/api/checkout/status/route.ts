import { sameOrigin } from "@/lib/admin-auth";
import { codRequestStatus, validCodStatusToken } from "@/lib/cod-request-status";
import { getDb } from "@/lib/db";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers });

  const input = await request.json().catch(() => null);
  if (!validCodStatusToken(input?.reference, input?.token)) {
    return new Response(null, { status: 404, headers });
  }

  try {
    const status = await codRequestStatus(await getDb(), input.reference);
    return Response.json({ status }, { headers });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
