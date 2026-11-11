import { Client, Events, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN?.trim();
const channelId = process.env.DISCORD_CHANNEL_ID?.trim();
const secret = process.env.INVENTORY_DISCORD_SECRET?.trim();
const apiUrl = (
  process.env.INVENTORY_API_URL?.trim() || "http://localhost:3000"
).replace(/\/$/, "");

if (!token || !channelId || !secret) {
  console.error(
    "Missing DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, or INVENTORY_DISCORD_SECRET in .env.local.",
  );
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (ready) => {
  console.log(
    `Discord bot connected as ${ready.user.tag}. Listening in channel ${channelId}.`,
  );
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.channelId !== channelId) return;

  const text = message.content.trim();
  const photos = message.attachments.filter((attachment) =>
    (attachment.contentType ?? "").startsWith("image/"),
  );

  try {
    if (photos.size > 0) {
      if (!text) {
        await message.reply(
          "Add your PIN to the photo message, e.g. `840071` (default: ADD 1) or `840071 SET 5`.",
        );
        return;
      }
      let index = 0;
      for (const photo of photos.values()) {
        index += 1;
        const response = await fetch(photo.url);
        if (!response.ok) {
          await message.reply(`Couldn't download that photo (${response.status}).`);
          continue;
        }
        const image = await response.arrayBuffer();
        const result = await postToInventory("/api/discord/inventory/photo", {
          headers: {
            "content-type": photo.contentType ?? "image/jpeg",
            "x-channel-id": message.channelId,
            "x-message-id": `${message.id}-${index}`,
            "x-command-text": text,
          },
          body: image,
        });
        if (result) await message.reply(result);
      }
      return;
    }

    if (!text) return;

    const result = await postToInventory("/api/discord/inventory", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: message.id,
        channelId: message.channelId,
        text,
      }),
    });
    if (result) await message.reply(result);
  } catch (error) {
    console.error("Discord inventory request failed", error);
  }
});

async function postToInventory(
  path: string,
  options: { headers: Record<string, string>; body: string | ArrayBuffer },
): Promise<string | null> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "x-inventory-secret": secret ?? "", ...options.headers },
    body: options.body,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    console.error("Inventory route failed", response.status, await response.text());
    return "Inventory request failed — check the dev server logs.";
  }

  const result = (await response.json()) as { reply?: string | null };
  return result.reply ?? null;
}

client.login(token).catch((error) => {
  console.error("Discord login failed", error);
  process.exit(1);
});
