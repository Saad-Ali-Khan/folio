import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { GET as testStatus, POST as sendTest } from "../app/api/admin/whatsapp/test/route";
import { GET as verifyWebhook, POST as receiveWebhook } from "../app/api/webhooks/whatsapp/route";
import { ADMIN_COOKIE, issueSession } from "../lib/admin-auth";

async function main() {
  const origin = "http://localhost:3000";
  const testUrl = `${origin}/api/admin/whatsapp/test`;
  const webhookUrl = `${origin}/api/webhooks/whatsapp`;
  process.env.ADMIN_PIN = "fake-admin-code";
  process.env.ADMIN_SESSION_SECRET = "fake-admin-session-secret";
  const cookie = `${ADMIN_COOKIE}=${issueSession()}`;
  const send = (headers: HeadersInit, body?: string) => sendTest(new Request(testUrl, { method: "POST", headers, body }));

  delete process.env.WHATSAPP_TEST_ACCESS_TOKEN;
  assert.deepEqual(await testStatus(new Request(testUrl, { headers: { cookie } })).json(), { configured: false });
  assert.equal((await send({ cookie, origin })).status, 503);

  process.env.WHATSAPP_TEST_ACCESS_TOKEN = "fake-token";
  process.env.WHATSAPP_TEST_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_TEST_RECIPIENT = "+15555550100";
  assert.equal(testStatus(new Request(testUrl)).status, 401);
  assert.equal((await send({ cookie, origin: "https://other.example" })).status, 403);
  assert.equal((await send({ origin })).status, 401);
  assert.deepEqual(await testStatus(new Request(testUrl, { headers: { cookie } })).json(), { configured: true });

  const fetchOriginal = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://graph.facebook.com/v25.0/123456789/messages");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-token");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.to, "15555550100");
      assert.equal(payload.template.name, "jaspers_market_plain_text_v1");
      return Response.json({ messages: [{ id: "wamid.test" }] });
    };
    const sent = await send({ origin, cookie }, JSON.stringify({ to: "15555550101" }));
    assert.deepEqual(await sent.json(), { accepted: true });
    globalThis.fetch = async () => Response.json({ error: { code: 190 } }, { status: 401 });
    const expired = await send({ origin, cookie });
    assert.equal(expired.status, 502);
    assert.match((await expired.json()).error, /test token expired/);
  } finally {
    globalThis.fetch = fetchOriginal;
  }

  const secret = "fake-meta-app-secret";
  process.env.WHATSAPP_APP_SECRET = secret;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "fake-verify-token";
  const challenge = `${webhookUrl}?hub.mode=subscribe&hub.challenge=1705`;
  assert.equal(verifyWebhook(new Request(challenge)).status, 403);
  assert.equal(await verifyWebhook(new Request(`${challenge}&hub.verify_token=fake-verify-token`)).text(), "1705");
  const sign = (body: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const receive = (body: string, signature?: string) => receiveWebhook(new Request(webhookUrl, {
    method: "POST", headers: signature ? { "x-hub-signature-256": signature } : {}, body,
  }));
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  assert.equal((await receive(body)).status, 403);
  assert.equal((await receive(body + " ", sign(body))).status, 403);
  assert.equal((await receive("{}", sign("{}"))).status, 400);
  assert.deepEqual(await (await receive(body, sign(body))).json(), { received: true });
  console.log("Passed WhatsApp test sender authorization, fixed recipient, token errors, and signed webhook validation.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
