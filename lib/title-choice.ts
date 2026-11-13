import {randomBytes} from 'node:crypto';
import {eq} from 'drizzle-orm';
import type {Database} from './db';
import {books,titleChoices} from './db/schema';
import type {ImportMetadata} from './import-metadata';
import {importDiscordBook} from './discord-inventory';

export type TitleChoiceReply = { reply: string; titleChoiceId?: string; completed?: boolean };

export async function queueTitleChoice(db:Database,sourceMessageId:string,channelId:string,userId:string,metadata:ImportMetadata,qty:number,bookId?:number){
 if(!userId) return { reply: 'Title confirmation requires the updated Discord bot. Restart the bot and resend your request.' };
 const [inserted]=await db.insert(titleChoices).values({id:randomBytes(5).toString('hex'),sourceMessageId,channelId,userId,metadata,qty,bookId,expiresAt:new Date(Date.now()+15*60000)}).onConflictDoNothing().returning();
 const choice=inserted??(await db.select().from(titleChoices).where(eq(titleChoices.sourceMessageId,sourceMessageId)))[0];
 if(!choice || choice.state!=='pending')return { reply: 'This title request was already handled.' };
 if(choice.expiresAt.getTime() <= Date.now())return { reply: 'This title request expired. Send a new photo or command.' };
 const options=choice.metadata.titleOptions!;
 return {
  titleChoiceId: choice.id,
  reply: `Choose the display title.\nEnglish: ${options.english}\nOriginal/catalog: ${options.original}\nThe choice expires in 15 minutes.${bookId ? '' : ' Stock is added after you choose.'}`,
 };
}
export async function resolveTitleChoice(db:Database,id:string,channelId:string,userId:string,selection:string): Promise<TitleChoiceReply>{
 if(!['ENGLISH','ORIGINAL','CANCEL'].includes(selection))return { reply: 'Choose ENGLISH, ORIGINAL, or CANCEL.' };
 return db.transaction(async tx=>{
  const [choice]=await tx.select().from(titleChoices).where(eq(titleChoices.id,id)).for('update');
  if(!choice || choice.channelId!==channelId || !userId || choice.userId!==userId)return { reply: 'Title request not found for your account and channel.' };
  if(choice.state!=='pending')return { reply: 'This title request was already handled.', completed: true };
  if(choice.expiresAt.getTime()<=Date.now())return { reply: 'Title choice expired. Scan again or use TITLES <ISBN> to request a new choice.', completed: true };
  if(selection==='CANCEL'){
   await tx.update(titleChoices).set({state:'cancelled'}).where(eq(titleChoices.id,id));
   return { reply: 'Cancelled. Inventory unchanged.', completed: true };
  }
  const title=selection==='ENGLISH'?choice.metadata.titleOptions!.english:choice.metadata.titleOptions!.original;
  let savedTitle=title;
  if(choice.bookId){
   const [book]=await tx.update(books).set({title}).where(eq(books.id,choice.bookId)).returning();
   if(!book)throw new Error('Book no longer exists');
  }else{
   const imported=await importDiscordBook(tx as unknown as Database,choice.sourceMessageId,channelId,{...choice.metadata,title},choice.qty);
   if(imported)savedTitle=imported.title;
  }
  await tx.update(titleChoices).set({state:selection.toLowerCase()}).where(eq(titleChoices.id,id));
  if(savedTitle!==title)return { reply: `Stock received for the existing edition, titled ${savedTitle}. Its title was kept; use TITLES ${choice.metadata.isbn ?? savedTitle} to review it.`, completed: true };
  return { reply: choice.bookId ? `Saved display title: ${title}.` : `Received ${choice.qty} ${choice.qty === 1 ? 'copy' : 'copies'} of ${title}. Review the draft in inventory and set its PKR price.`, completed: true };
 });
}
