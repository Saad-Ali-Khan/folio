import {getDb} from "@/lib/db";
import {books} from "@/lib/db/schema";
import {requestIsAdmin,sameOrigin} from "@/lib/admin-auth";
import {updateAdminBook,deleteAdminBook,AdminBookError} from "@/lib/admin-books";
export async function GET(request:Request){
 if(!requestIsAdmin(request))return Response.json({error:'Please unlock inventory.'},{status:401});
 try{return Response.json({books:await (await getDb()).select().from(books).orderBy(books.title,books.id)},{headers:{'Cache-Control':'no-store'}});}
 catch(error){console.error('Inventory load failed',error);return Response.json({error:'Inventory could not load. Try again.'},{status:500});}
}
export async function PATCH(request:Request){
 if(!sameOrigin(request))return Response.json({error:'Invalid request origin.'},{status:403});
 if(!requestIsAdmin(request))return Response.json({error:'Your session expired. Unlock inventory again.'},{status:401});
 let input;try{input=await request.json();}catch{return Response.json({error:'Invalid request.'},{status:400});}
 try{return Response.json({book:await updateAdminBook(await getDb(),input)});}
 catch(error){if(error instanceof AdminBookError)return Response.json({error:error.message},{status:error.status});console.error('Inventory update failed',error);return Response.json({error:'Could not save this book.'},{status:500});}
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  if (!requestIsAdmin(request)) return Response.json({ error: "Your session expired. Unlock inventory again." }, { status: 401 });

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    return Response.json(await deleteAdminBook(await getDb(), input));
  } catch (error) {
    if (error instanceof AdminBookError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Inventory deletion failed", error);
    return Response.json({ error: "Could not delete this book." }, { status: 500 });
  }
}
