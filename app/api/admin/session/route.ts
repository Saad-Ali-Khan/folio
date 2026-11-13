import {NextResponse} from "next/server";
import {ADMIN_COOKIE,SESSION_SECONDS,adminConfigured,issueSession,validAdminPin,requestIsAdmin,sameOrigin} from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { clientKey, consumeRequestLimit } from "@/lib/request-limits";

export async function GET(request:Request){return NextResponse.json({authenticated:requestIsAdmin(request),configured:adminConfigured()},{headers:{'Cache-Control':'no-store'}});}
export async function POST(request:Request){
 if(!sameOrigin(request))return NextResponse.json({error:'Invalid request origin.'},{status:403});
 if(!adminConfigured())return NextResponse.json({error:'Admin access is not configured.'},{status:503});
 const client = clientKey(request);
 if (!client) return NextResponse.json({ error: 'Admin access is unavailable.' }, { status: 503 });
 if (!await consumeRequestLimit(await getDb(), `admin:${client}`, 5, 60)) {
  return NextResponse.json({error:'Too many attempts. Try again in a minute.'},{status:429});
 }
 let body;try{body=await request.json();}catch{return NextResponse.json({error:'Invalid request.'},{status:400});}
 if(!validAdminPin(body?.pin)){
  return NextResponse.json({error:'Incorrect PIN.'},{status:401});
 }
 const response=NextResponse.json({authenticated:true});
 response.cookies.set(ADMIN_COOKIE,issueSession(),{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'||new URL(request.url).protocol==='https:',maxAge:SESSION_SECONDS,path:'/api/admin'});
 return response;
}
export async function DELETE(request:Request){
 if(!sameOrigin(request))return NextResponse.json({error:'Invalid request origin.'},{status:403});
 const response=NextResponse.json({authenticated:false});
 response.cookies.set(ADMIN_COOKIE,'',{httpOnly:true,sameSite:'strict',maxAge:0,path:'/api/admin'});return response;
}
