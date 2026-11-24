import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./local-runtime";

try {
  const release = acquireLock(fileURLToPath(new URL("../.folio-local/bot.lock", import.meta.url)));
  process.once("exit", release);
} catch {
  console.error("Discord bot already running or its lock cannot be inspected. Stop the existing bot first.");
  process.exit(78);
}

type InventoryReply = { reply?: string | null; titleChoiceId?: string; completed?: boolean; cleanupAt?: string; coverMatch?: { id: string; covers: {id:string;label:string}[] } };

async function replyOptions(result: InventoryReply, owner: { userId: string; channelId: string }) {
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const files: AttachmentBuilder[] = [];
  const embeds: {title:string;image:{url:string}}[] = [];
  if (result.coverMatch) {
    try {
      if (!result.coverMatch.covers.length || result.coverMatch.covers.length > 4) throw new Error("Invalid retained cover count.");
      for (const [index, cover] of result.coverMatch.covers.entries()) {
        const response = await fetch(`${apiUrl}/api/discord/inventory/cover-preview?id=${encodeURIComponent(cover.id)}`, {
          headers: { "x-inventory-secret": secret!, "x-channel-id": owner.channelId, "x-user-id": owner.userId }, signal: AbortSignal.timeout(25000), redirect: "error",
        });
        if (!response.ok) throw new Error("Retained cover preview unavailable.");
        const image = Buffer.from(await response.arrayBuffer());
        if (image.length > 512 * 1024) throw new Error("Retained cover too large.");
        const name = `retained-cover-${index+1}.webp`;
        files.push(new AttachmentBuilder(image, { name }));
        embeds.push({ title: cover.label, image: { url: `attachment://${name}` } });
      }
      const buttons = result.coverMatch.covers.map(c => new ButtonBuilder().setCustomId(`folio-cover:${result.coverMatch!.id}:${c.id}`).setLabel(result.coverMatch!.covers.length === 1 ? `Same book · ${c.label}` : `Use ${c.label}`).setStyle(ButtonStyle.Primary));
      buttons.push(new ButtonBuilder().setCustomId(`folio-cover:${result.coverMatch.id}:SKIP`).setLabel("Barcode only").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`folio-cover:${result.coverMatch.id}:CANCEL`).setLabel("Cancel scan").setStyle(ButtonStyle.Secondary));
      for (let i=0;i<buttons.length;i+=5) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(i,i+5)));
    } catch {
      return { content: "The retained cover preview is unavailable or expired. No stock was added. Send the barcode again to retry.", components: [], files: [], embeds: [], allowedMentions: { parse: [], repliedUser: false } };
    }
  }
  if (result.titleChoiceId) {
    const id = result.titleChoiceId;
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`folio-title:${id}:ENGLISH`).setLabel("English").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`folio-title:${id}:ORIGINAL`).setLabel("Original title").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`folio-title:${id}:CANCEL`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ));
  }
  return { content: result.reply ?? "", components, files, embeds, allowedMentions: { parse: [], repliedUser: false } };
}

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
  rest: { timeout: 10_000, retries: 1 },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// The supervisor waits for Gateway readiness; no customer messages are sent by monitoring.
const heartbeat = setInterval(() => {
  if (process.connected) process.send?.({ type: "folio-bot-health", ready: client.isReady() });
}, 10_000);
heartbeat.unref();
function shutdown() {
  clearInterval(heartbeat);
  client.destroy();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
client.on(Events.Error, error => console.error("Discord client error", error.message));

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
      if ("sendTyping" in message.channel) await message.channel.sendTyping().catch(() => {});
      let index = 0;
      for (const photo of photos.values()) {
        index += 1;
        if (photo.size > 12 * 1024 * 1024) {
          await message.reply("This photo exceeds 12 MB. Send a smaller image.");
          continue;
        }
        const response = await fetch(photo.url, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
          await message.reply(`Couldn't download that photo (${response.status}).`);
          continue;
        }
        const image = await response.arrayBuffer();
        const result = await postToInventory("/api/discord/inventory/photo", {
          headers: {
            "content-type": photo.contentType ?? "image/jpeg",
            "x-channel-id": message.channelId,
            "x-user-id": message.author.id,
            "x-guild-owner-id": message.guild?.ownerId ?? "",
            "x-message-id": `${message.id}-${index}`,
            "x-command-text": text,
          },
          body: image,
        });
        if (result.reply) await message.reply(await replyOptions(result, {userId:message.author.id,channelId:message.channelId}));
      }
      return;
    }

    if (!text) return;

    const result = await postToInventory("/api/discord/inventory", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: message.author.id,
        messageId: message.id,
        channelId: message.channelId,
        text,
      }),
    });
    if (result.reply) await message.reply(await replyOptions(result, {userId:message.author.id,channelId:message.channelId}));
  } catch (error) {
    console.error("Discord inventory request failed", error);
    await message.reply({
      content: "I couldn't confirm the result from the inventory app. Check the book's stock in admin before resending, since the upload may have completed. Make sure the local app is running.",
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(replyError => console.error("Discord error reply failed", replyError));
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() || interaction.channelId !== channelId) return;
  const choice = /^folio-title:([0-9a-f]{10}):(ENGLISH|ORIGINAL|CANCEL)$/.exec(interaction.customId);
  const cover = /^folio-cover:([0-9a-f]{10}):([0-9a-f]{20}|SKIP|CANCEL)$/.exec(interaction.customId);
  if (!choice && !cover) return;
  try {
    await interaction.reply({
      content: "Saving your confirmation…",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    const result = await postToInventory("/api/discord/inventory", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: interaction.id,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        ...(choice ? { titleChoice: { id: choice[1], selection: choice[2] } } : { coverChoice: { id: cover![1], selection: cover![2] } }),
      }),
    });
    let updated = false;
    if (result.completed) {
      updated = await interaction.message.edit({ ...await replyOptions(result, {userId:interaction.user.id,channelId:interaction.channelId!}), attachments: [] })
        .then(()=>true).catch(()=>false);
    }
    await interaction.editReply({ content: updated ? "Saved. See the updated message above." : result.reply ?? "Confirmation unavailable.", allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("Discord title button failed", error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("Could not confirm the title response. Check the book in admin before retrying.").catch(console.error);
    }
  }
});

async function postToInventory(
  path: string,
  options: { headers: Record<string, string>; body: string | ArrayBuffer },
): Promise<InventoryReply> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "x-inventory-secret": secret ?? "", ...options.headers },
    body: options.body,
    signal: AbortSignal.timeout(75_000),
  });

  if (!response.ok) {
    console.error("Inventory route failed", response.status, await response.text());
    return { reply: "Inventory request failed. Check the app logs." };
  }

  const result = await response.json() as InventoryReply;
  if (result.cleanupAt && Number.isFinite(Date.parse(result.cleanupAt)) && process.connected) process.send?.({type:"folio-cover-cleanup",at:Date.parse(result.cleanupAt)});
  return result;
}

client.login(token).catch((error) => {
  console.error("Discord login failed", error);
  process.exit(1);
});
