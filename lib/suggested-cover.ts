import {randomBytes} from "node:crypto";
import {and,eq,gt,sql} from "drizzle-orm";
import type {Database} from "./db";
import {coverBarcodeChoices,pendingCovers} from "./db/schema";
import type {EditionCandidate} from "./edition-types";
import type {CoverReply} from "./pending-covers";

/** Persist only review choices; neither suggestions nor previews receive stock. */
export async function queueSuggestedCover(db:Database,coverId:string,userId:string,channelId:string,candidates:EditionCandidate[]):Promise<CoverReply|null> {
  return db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'folio:manual-cover:'+coverId}))`);
    const [cover]=await tx.select().from(pendingCovers).where(and(eq(pendingCovers.id,coverId),eq(pendingCovers.userId,userId),
      eq(pendingCovers.channelId,channelId),eq(pendingCovers.state,"waiting"),gt(pendingCovers.expiresAt,new Date()))).for("update");
    if(!cover)return null;
    const choices:NonNullable<CoverReply["coverSuggestions"]>=[];
    for(const candidate of candidates.slice(0,3)) {
      const sourceMessageId=`suggest:${cover.id}:${candidate.id}`;
      const [created]=await tx.insert(coverBarcodeChoices).values({id:randomBytes(5).toString("hex"),sourceMessageId,userId,channelId,
        coverIds:[cover.id],qty:cover.qty,explicitQty:0,expiresAt:cover.expiresAt,
        metadata:{title:candidate.title,author:candidate.author,isbn:null,coverUrl:null,manualEntryId:cover.id,editionCandidates:[candidate],
          description:candidate.identityEvidence==='title-author-only'?
            "Title and author read from the cover and confirmed by the operator. Catalog artwork not matched; publisher, physical ISBN, edition and translator remain unverified.":
            "Title and author suggested from partial OCR and catalog artwork, confirmed by the operator. Physical ISBN, edition and translator remain unverified."}
      }).onConflictDoNothing({target:coverBarcodeChoices.sourceMessageId}).returning();
      const row=created??(await tx.select().from(coverBarcodeChoices).where(eq(coverBarcodeChoices.sourceMessageId,sourceMessageId)))[0];
      if(row?.state==="pending")choices.push({id:row.id,title:candidate.title,author:candidate.author,coverUrl:candidate.coverUrl,source:candidate.source,
        note:candidate.identityEvidence==='title-author-only'?"Title and author match the cover text. Catalog artwork not matched—edition unverified. Your uploaded photo is kept; no catalog ISBN or edition details will be copied.":
          candidate.identityEvidence==="author-and-artwork"?"Only the full author name was readable. The title is a catalog proposal based on similar artwork; check it carefully.":undefined});
    }
    return choices.length?{reply:"I found possible catalog matches. Review the title, author and artwork warning before confirming. Nothing has been added. Confirmation creates a separate draft; the catalog ISBN stays unlinked. Your photo is private for 15 minutes. You can also enter the title/author or send the barcode.",
      manualCoverId:cover.id,coverSuggestions:choices,cleanupAt:cover.expiresAt.toISOString()}:null;
  });
}

export async function previewSuggestedCover(db:Database,id:string,userId:string,channelId:string):Promise<CoverReply> {
  const unavailable={reply:"This suggestion expired, changed or is unavailable for your account/channel. No stock was added."};
  const [choice]=await db.select().from(coverBarcodeChoices).where(and(eq(coverBarcodeChoices.id,id),eq(coverBarcodeChoices.userId,userId),
    eq(coverBarcodeChoices.channelId,channelId),eq(coverBarcodeChoices.state,"pending"),gt(coverBarcodeChoices.expiresAt,new Date())));
  const coverId=choice?.metadata.manualEntryId,candidate=choice?.metadata.editionCandidates?.[0];
  if(!choice?.sourceMessageId.startsWith("suggest:")||!coverId||!candidate)return unavailable;
  const [cover]=await db.select().from(pendingCovers).where(and(eq(pendingCovers.id,coverId),eq(pendingCovers.userId,userId),
    eq(pendingCovers.channelId,channelId),eq(pendingCovers.state,"waiting"),gt(pendingCovers.expiresAt,new Date())));
  if(!cover)return unavailable;
  return {reply:`Review the manual draft.\nTitle: ${choice.metadata.title}\nAuthor: ${choice.metadata.author}\nQuantity: ${cover.qty}\nSuggested catalog source: ${candidate.source}\n${candidate.identityEvidence==='title-author-only'?"Catalog artwork not matched—edition unverified. Confirm the title and author against your saved photo. The catalog image is only an example; its artwork, ISBN and edition details will not be copied.\n":candidate.identityEvidence==="author-and-artwork"?"Only the full author name was readable; this title is proposed from catalog artwork, not verified OCR.\n":""}Confirm only if this is your book. This receives a separate draft, even if a matching listing already exists. ISBN, edition and translator remain unverified. No stock has been added.`,
    manualDraftChoice:{id:choice.id,coverId,qty:cover.qty},coverMatch:{id:choice.id,covers:[{id:coverId,label:"Your saved cover"}]},
    suggestedCatalog:{title:candidate.title,coverUrl:candidate.coverUrl,source:candidate.source,artworkUnmatched:candidate.identityEvidence==='title-author-only'},cleanupAt:cover.expiresAt.toISOString()};
}
