import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";
import {drizzle} from "drizzle-orm/pglite";
import {eq} from "drizzle-orm";
import {renderToStaticMarkup} from "react-dom/server";
import * as schema from "../lib/db/schema";
import type {Database} from "../lib/db";
import {ADMIN_COOKIE,issueSession} from "../lib/admin-auth";
import {GET,POST} from "../app/api/admin/cod/orders/route";
import {CodCashPanel,cashStatus} from "../components/cod-cash-panel";
import {parseCodCash} from "../lib/cod-cash";

async function main(){
  assert.equal(parseCodCash("3250.01"),325001);assert.equal(parseCodCash("0"),0);assert.equal(parseCodCash("21474836.47"),2147483647);
  for(const value of ["21474836.48","-1","1e3","1.001","NaN"," 12",null,12])assert.equal(parseCodCash(value),null);
  const engine=new PGlite(),db=drizzle(engine,{schema}) as unknown as Database;
  const globals=globalThis as typeof globalThis & {folioDb?:Promise<Database>},previousDb=globals.folioDb;
  const keys=["ADMIN_PIN","ADMIN_SESSION_SECRET","INVENTORY_DISCORD_PIN","APP_URL"];const previous=keys.map(key=>process.env[key]);
  try {
    for(const file of readdirSync("drizzle").filter(file=>file.endsWith(".sql")).sort())await engine.exec(readFileSync(`drizzle/${file}`,"utf8"));
    globals.folioDb=Promise.resolve(db);process.env.ADMIN_PIN="cash-test-admin-code";process.env.ADMIN_SESSION_SECRET="cash-test-session-secret-not-production";process.env.INVENTORY_DISCORD_PIN="other-test-pin";process.env.APP_URL="http://localhost:3000";
    const url="http://localhost:3000/api/admin/cod/orders",headers={cookie:`${ADMIN_COOKIE}=${issueSession()}`,origin:"http://localhost:3000","content-type":"application/json"};
    const [book]=await db.insert(schema.books).values({isbn:"cash-test-book",slug:"cash-test-book",title:"Cash test",author:"Test author",priceCents:300000,stock:7}).returning();
    const make=async(stage="delivered",method="cod")=>{
      const [row]=await db.insert(schema.orders).values({paymentMethod:method,status:"cash_due",fulfillmentStatus:stage,subtotalCents:300000,shippingCents:25000,totalCents:325000}).returning();
      await db.insert(schema.orderItems).values({orderId:row.id,bookId:book.id,title:book.title,qty:1,priceCents:300000});return row;
    };
    const order=await make();
    const read=async(id=order.id)=>(await db.select().from(schema.orders).where(eq(schema.orders.id,id)))[0];
    const snapshot=(row:Awaited<ReturnType<typeof read>>)=>({id:row.id,fulfillmentStatus:row.fulfillmentStatus,subtotalCents:row.subtotalCents,totalCents:row.totalCents,status:row.status,collectedAt:row.collectedAt?.toISOString()??null,remittedAt:row.remittedAt?.toISOString()??null});
    const post=(body:Record<string,unknown>,auth=headers)=>POST(new Request(url,{method:"POST",headers:auth,body:JSON.stringify(body)}));
    const queue=async()=>((await (await GET(new Request(url,{headers}))).json()).orders as {id:number}[]).map(row=>row.id);
    const getOrder=async()=>((await (await GET(new Request(`${url}?id=${order.id}`,{headers}))).json()).orders[0]);
    assert((await queue()).includes(order.id),"delivered unpaid order remains actionable");
    const initial=snapshot(order),collect={...initial,action:"collected",amount:"3250.00"};
    assert.equal((await post(collect,{...headers,cookie:""})).status,401);
    assert.equal((await post(collect,{...headers,origin:"https://example.invalid"})).status,403);
    assert.equal((await post({...collect,amount:"3249.99"})).status,400);
    assert.equal((await post({...collect,totalCents:325001})).status,409);
    assert.equal((await post({...collect,collectedAt:"bad"})).status,400);
    assert.equal((await post({...collect,action:"remitted",amount:"3000",reference:"courier-1"})).status,409);
    for(const stage of ["unfulfilled","packed","shipped","returned","cancelled"]){
      const row=await make(stage);assert.equal((await post({...snapshot(row),action:"collected",amount:"3250"})).status,stage==="cancelled"?400:409);
    }
    const stripe=await make("delivered","stripe");assert.equal((await post({...snapshot(stripe),action:"collected",amount:"3250"})).status,404);
    const beforeMarkup=renderToStaticMarkup(<CodCashPanel order={order} busy={false} onRecord={()=>{}}/>);
    assert(beforeMarkup.includes("Record cash collected"));assert(!beforeMarkup.includes("Record courier payout"));
    const collection=await post(collect);assert.equal(collection.status,200);assert.equal(collection.headers.get("cache-control"),"no-store");
    const paid=await read();assert.equal(paid.status,"paid");assert(paid.collectedAt);assert.equal(paid.remittedAt,null);
    assert((await queue()).includes(order.id),"collected but unremitted remains actionable");
    const repeatCollection=await post(collect);assert.equal(repeatCollection.status,200);assert.equal((await read()).collectedAt?.toISOString(),paid.collectedAt?.toISOString());
    const payout={...snapshot(paid),action:"remitted",amount:"3000.25",reference:"statement-test-1"};
    for(const amount of ["-1","3250.01","1.001",100])assert.equal((await post({...payout,amount})).status,400);
    for(const reference of ["","x".repeat(201),"bad\nreference"])assert.equal((await post({...payout,reference})).status,400);
    assert.equal((await post({...payout,collectedAt:null})).status,409);
    const paidMarkup=renderToStaticMarkup(<CodCashPanel order={paid} busy={false} onRecord={()=>{}}/>);
    assert(paidMarkup.includes("Record courier payout"));assert(!paidMarkup.includes("Record cash collected"));assert(paidMarkup.includes("awaiting courier payout"));
    const payouts=await Promise.all([post(payout),post(payout)]);assert(payouts.every(response=>response.status===200));
    const settled=await read();assert.equal(settled.remittedCents,300025);assert.equal(settled.remittanceReference,"statement-test-1");assert(settled.remittedAt);
    assert.equal((await post({...payout,amount:"3000.26"})).status,409);assert.equal((await post({...payout,reference:"changed-statement"})).status,409);
    assert.equal((await read()).remittedAt?.toISOString(),settled.remittedAt?.toISOString());
    assert(!(await queue()).includes(order.id),"settled order leaves active queue");
    const saved=await getOrder();assert.equal(saved.remittedCents,300025);assert.equal(saved.remittanceReference,"statement-test-1");
    const markup=renderToStaticMarkup(<CodCashPanel order={saved} busy={false} onRecord={()=>{}}/>);
    assert(markup.includes("statement-test-1"));assert(markup.includes("Difference from customer payment"));assert(!markup.includes("<form"));assert.equal(cashStatus(saved),"Payout received by Folio");
    assert.match(markup,/3,000\.25/,"saved net payout must show its exact paisa amount");
    assert.match(markup,/249\.75/,"customer/payout difference must not be rounded");
    const zero=await make();await post({...snapshot(zero),action:"collected",amount:"3250"});const zeroPaid=await read(zero.id);
    assert.equal((await post({...snapshot(zeroPaid),action:"remitted",amount:"0",reference:"zero-net-statement"})).status,200);
    assert.equal((await read(zero.id)).remittedCents,0);
    assert.equal((await db.select().from(schema.books).where(eq(schema.books.id,book.id)))[0].stock,7);
    assert.equal((await db.select().from(schema.stockMovements)).filter(row=>row.bookId===book.id).length,1,"cash actions do not create stock movements");
    console.log("PASS exact decimal amounts, delivered-stage collection, net payout/reference validation, stale snapshots, auth/origin protection and identical replay/concurrency");
    console.log("PASS independent customer/courier status, active delivered queue until settlement, saved receipt/dates, zero-net payout and stage-specific GUI controls; stock unchanged. Isolated synthetic orders only.");
  }finally{globals.folioDb=previousDb;keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});await engine.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
