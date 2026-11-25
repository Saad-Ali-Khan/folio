import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } from "discord.js";
import type {CoverReply} from "./pending-covers";

export function catalogSuggestionUi(result:Pick<CoverReply,"coverSuggestions"|"suggestedCatalog">) {
  const suggestions=(result.coverSuggestions??[]).slice(0,3);
  const components=suggestions.length?[new ActionRowBuilder<ButtonBuilder>().addComponents(...suggestions.map((item,i)=>
    new ButtonBuilder().setCustomId(`folio-suggest:${item.id}`).setLabel(`Review suggestion ${i+1}`).setStyle(ButtonStyle.Primary)))]:[];
  const embeds=suggestions.map((item,i)=>({title:`Possible match ${i+1}: ${item.title}`,description:`${item.author}\n${item.note??"Catalog suggestion — compare with your copy."}`,url:item.source,image:{url:item.coverUrl}}));
  if(result.suggestedCatalog)embeds.push({title:`Catalog cover: ${result.suggestedCatalog.title}`,description:"Compare with your saved photo. ISBN and edition are not verified.",url:result.suggestedCatalog.source,image:{url:result.suggestedCatalog.coverUrl}});
  return {components,embeds};
}

export function manualCoverModal(coverId: string, previousContent = "") {
  if (!/^[a-f0-9]{20}$/.test(coverId)) throw Error("Invalid saved cover");
  const title = new TextInputBuilder().setCustomId("title").setLabel("Book title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
  const author = new TextInputBuilder().setCustomId("author").setLabel("Author").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(140);
  if (previousContent.startsWith("Review the manual draft.")) {
    const oldTitle = /^Title: (.+)$/m.exec(previousContent)?.[1];
    const oldAuthor = /^Author: (.+)$/m.exec(previousContent)?.[1];
    if (oldTitle && oldTitle.length <= 200) title.setValue(oldTitle);
    if (oldAuthor && oldAuthor.length <= 140) author.setValue(oldAuthor);
  }
  return new ModalBuilder().setCustomId(`folio-manual-form:${coverId}`).setTitle("Identify this cover")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(title), new ActionRowBuilder<TextInputBuilder>().addComponents(author));
}
