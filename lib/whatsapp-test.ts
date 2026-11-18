export function whatsAppTestConfig() {
  const token = process.env.WHATSAPP_TEST_ACCESS_TOKEN?.trim();
  const phoneId = process.env.WHATSAPP_TEST_PHONE_NUMBER_ID?.trim() ?? "";
  const recipient = process.env.WHATSAPP_TEST_RECIPIENT?.trim().replace(/^\+/, "") ?? "";
  if (!token || !/^\d+$/.test(phoneId) || !/^[1-9]\d{7,14}$/.test(recipient)) return null;
  return { token, phoneId, recipient };
}

export async function sendWhatsAppTest({ token, phoneId, recipient }: NonNullable<ReturnType<typeof whatsAppTestConfig>>) {
  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient,
        type: "template",
        template: { name: "jaspers_market_plain_text_v1", language: { code: "en_US" } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    if (!response.ok || typeof result?.messages?.[0]?.id !== "string") {
      return { error: result?.error?.code === 190
        ? "The Meta test token expired or is invalid. Generate a new test token."
        : "Meta did not accept the test message. Check the test number and recipient in Meta API Setup." };
    }
    return { accepted: true };
  } catch {
    return { error: "Could not confirm that Meta accepted the message. Check your phone before retrying." };
  }
}
