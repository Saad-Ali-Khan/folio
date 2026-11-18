import { requestIsAdmin, sameOrigin } from "@/lib/admin-auth";
import { sendWhatsAppTest, whatsAppTestConfig } from "@/lib/whatsapp-test";

const headers = { "Cache-Control": "no-store" };

export function GET(request: Request) {
  if (!requestIsAdmin(request)) return new Response(null, { status: 401, headers });
  return Response.json({ configured: Boolean(whatsAppTestConfig()) }, { headers });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers });
  if (!requestIsAdmin(request)) return new Response(null, { status: 401, headers });
  const config = whatsAppTestConfig();
  if (!config) return Response.json({ error: "WhatsApp test messaging is unconfigured." }, { status: 503, headers });

  const result = await sendWhatsAppTest(config);
  return Response.json(result, { status: result.accepted ? 200 : 502, headers });
}
