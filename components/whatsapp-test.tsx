"use client";

import { useEffect, useState } from "react";

const endpoint = "/api/admin/whatsapp/test";

export function WhatsAppTest() {
  const [configured, setConfigured] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ message: string; error: boolean }>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal }).then(async response => {
      if (response.ok) {
        const data = await response.json();
        setConfigured(data.configured === true);
      }
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  async function send() {
    if (sending) return;
    setSending(true);
    setStatus(undefined);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      if (response.status === 401) throw new Error("Unlock inventory again to send a test message.");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setStatus({ message: "Meta accepted the test message. Check your WhatsApp inbox.", error: false });
    } catch (caught) {
      setStatus({ message: caught instanceof Error ? caught.message : "Could not send the test message.", error: true });
    } finally {
      setSending(false);
    }
  }

  if (!configured) return null;
  return (
    <section className="mt-8 rounded-xl border border-ink/10 bg-white/50 p-5" aria-labelledby="whatsapp-test-heading">
      <h2 id="whatsapp-test-heading" className="font-display text-2xl">WhatsApp test</h2>
      <p className="mt-2 text-sm text-ink/70">Send Meta’s sample message from the test number to your configured test recipient.</p>
      <button type="button" className="mt-4 rounded-full bg-ink px-4 py-2 text-sm text-cream disabled:opacity-50"
        disabled={sending} onClick={() => void send()}>
        {sending ? "Sending…" : "Send test message"}
      </button>
      {status && <p role={status.error ? "alert" : "status"}
        className={`mt-3 text-sm ${status.error ? "text-red-700" : "text-accent"}`}>{status.message}</p>}
    </section>
  );
}
