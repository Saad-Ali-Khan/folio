import {and,eq,sql} from "drizzle-orm";
import type {Database} from "./db";
import {books} from "./db/schema";
export class AdminBookError extends Error {constructor(message:string,public status=400){super(message);}}

export async function deleteAdminBook(db: Database, input: unknown) {
  const expected = (input as { expected?: Record<string, unknown> } | null)?.expected;
  if (!expected || typeof expected.id !== "number" || !Number.isInteger(expected.id) ||
      expected.id < 1 || expected.id > 2147483647 || typeof expected.title !== "string" ||
      typeof expected.author !== "string" || typeof expected.description !== "string" ||
      typeof expected.status !== "string" || typeof expected.stock !== "number" ||
      typeof expected.priceCents !== "number") {
    throw new AdminBookError("Reload the book before deleting it.");
  }

  try {
    const [removed] = await db.delete(books).where(and(
      eq(books.id, expected.id),
      eq(books.title, expected.title),
      eq(books.author, expected.author),
      eq(books.description, expected.description),
      eq(books.status, expected.status),
      eq(books.stock, expected.stock),
      eq(books.priceCents, expected.priceCents),
    )).returning({ id: books.id });
    if (!removed) throw new AdminBookError("This book changed or was already deleted. Refresh inventory and try again.", 409);
    return removed;
  } catch (error) {
    // Drizzle can wrap PostgreSQL errors in one or more causes.
    let cause: unknown = error;
    while (cause && typeof cause === "object") {
      if ("code" in cause && cause.code === "23503") {
        throw new AdminBookError("This book appears in an order. Move it to Draft to hide it from the shop.", 409);
      }
      if ("message" in cause && cause.message === "Book has an active checkout reservation") {
        throw new AdminBookError("This book has an active checkout reservation. Try again after it expires or is cancelled.", 409);
      }
      cause = "cause" in cause ? cause.cause : undefined;
    }
    throw error;
  }
}
export async function updateAdminBook(db:Database,input:unknown){
 if(!input || typeof input!=='object')throw new AdminBookError('Invalid book.');
 const raw=input as Record<string,unknown>;
 const text=(key:string,max:number)=>{const v=raw[key];if(typeof v!=='string'||v.length>max)throw new AdminBookError(`Invalid ${key}.`);return v.trim();};
 const id=raw.id;
 if(!Number.isSafeInteger(id)||Number(id)<1)throw new AdminBookError('Invalid book ID.');
 const title=text('title',300),author=text('author',300),description=text('description',10000),price=text('price',20),status=text('status',20);
 if(!title||!author)throw new AdminBookError('Title and author are required.');
 if(!/^\d+(\.\d{1,2})?$/.test(price))throw new AdminBookError('Enter a PKR price with up to two decimal places.');
 const priceCents=Math.round(Number(price)*100);
 if(!Number.isSafeInteger(priceCents)||priceCents>100000000)throw new AdminBookError('Price is too large.');
 const stock=raw.stock;
 if(!Number.isSafeInteger(stock)||Number(stock)<0||Number(stock)>1000000)throw new AdminBookError('Stock must be a whole number between 0 and 1,000,000.');
 if(!['draft','published'].includes(status))throw new AdminBookError('Invalid publication status.');
 if(status==='published' && (priceCents<=0 || author.toLowerCase()==='unknown author'))throw new AdminBookError('Set a positive price and a verified author before publishing.');
 const expected=raw.expected as Record<string,unknown>|undefined;
 if(!expected || typeof expected.title!=='string'||typeof expected.author!=='string'||typeof expected.description!=='string'||typeof expected.status!=='string'||!Number.isSafeInteger(expected.priceCents)||!Number.isSafeInteger(expected.stock))throw new AdminBookError('Reload this book before editing.');
 return db.transaction(async tx=>{
  await tx.execute(sql`select set_config('folio.stock_reason','admin inventory edit',true)`);
  const [updated]=await tx.update(books).set({title,author,description,priceCents,stock:Number(stock),status})
   .where(and(eq(books.id,Number(id)),eq(books.title,expected.title as string),eq(books.author,expected.author as string),eq(books.description,expected.description as string),eq(books.priceCents,Number(expected.priceCents)),eq(books.stock,Number(expected.stock)),eq(books.status,expected.status as string))).returning();
  if(!updated)throw new AdminBookError('This book changed while you were editing. Reload the inventory and try again.',409);
  return updated;
 });
}
