import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";

type InventoryReply = { reply?: string | null; titleChoiceId?: string; completed?: boolean };

function replyOptions(result: InventoryReply) {
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (result.titleChoiceId) {
    const id = result.titleChoiceId;
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`folio-title:${id}:ENGLISH`).setLabel("English").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`folio-title:${id}:ORIGINAL`).setLabel("Original title").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`folio-title:${id}:CANCEL`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ));
  }
  return { content: result.reply ?? "", components, allowedMentions: { parse: [], repliedUser: false } };
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
        if (result.reply) await message.reply(replyOptions(result));
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
    if (result.reply) await message.reply(replyOptions(result));
  } catch (error) {
    console.error("Discord inventory request failed", error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() || interaction.channelId !== channelId) return;
  const choice = /^folio-title:([0-9a-f]{10}):(ENGLISH|ORIGINAL|CANCEL)$/.exec(interaction.customId);
  if (!choice) return;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await postToInventory("/api/discord/inventory", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId: interaction.id,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        titleChoice: { id: choice[1], selection: choice[2] },
      }),
    });
    await interaction.editReply({ content: result.reply ?? "Title request unavailable.", allowedMentions: { parse: [] } });
    if (result.completed) await interaction.message.edit({ components: [] });
  } catch (error) {
    console.error("Discord title button failed", error);
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply("Could not save that title choice. Try again.").catch(console.error);
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

  return await response.json() as InventoryReply;
}

client.login(token).catch((error) => {
  console.error("Discord login failed", error);
  process.exit(1);
});
