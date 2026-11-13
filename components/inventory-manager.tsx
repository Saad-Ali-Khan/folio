"use client";

import {useEffect,useMemo,useState,type FormEvent} from "react";
import Link from "next/link";
import {BookCover} from "./book-cover";
import {formatPrice} from "@/lib/format";

type InventoryBook={id:number;isbn:string;slug:string;title:string;author:string;description:string;priceCents:number;stock:number;status:string;coverUrl:string|null};
type Filter='all'|'draft'|'published';
const field="mt-1.5 w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/15";
const primary="rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-white transition hover:bg-accent/90 disabled:cursor-wait disabled:opacity-50";

export function InventoryManager(){
 const [auth,setAuth]=useState<boolean|null>(null),[pin,setPin]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [books,setBooks]=useState<InventoryBook[]>([]),[filter,setFilter]=useState<Filter>('draft'),[query,setQuery]=useState('');
 const [selected,setSelected]=useState<InventoryBook|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
 async function load(){
  setLoading(true);
  try{const res=await fetch('/api/admin/books',{cache:'no-store'});const data=await res.json();if(res.status===401){setAuth(false);return;}if(!res.ok)throw Error(data.error);setBooks(data.books);}
  catch(e){setError(e instanceof Error?e.message:'Could not load inventory.');}finally{setLoading(false);}
 }
 useEffect(()=>{let active=true;fetch('/api/admin/session',{cache:'no-store'}).then(r=>r.json()).then(data=>{if(active){setAuth(data.authenticated);if(data.authenticated)void load();if(!data.configured)setError('Set an admin PIN and session secret in your local configuration first.');}}).catch(()=>{if(active){setAuth(false);setError('Unable to connect. Please try again.');}});return()=>{active=false;};},[]);
 async function unlock(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{const res=await fetch('/api/admin/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});const data=await res.json();if(!res.ok)throw Error(data.error);setPin('');setAuth(true);void load();}catch(e){setError(e instanceof Error?e.message:'Unable to unlock.');}finally{setBusy(false);}}
 async function lock(){setBusy(true);setError('');try{const res=await fetch('/api/admin/session',{method:'DELETE'});if(!res.ok)throw Error('Could not lock inventory.');setSelected(null);setBooks([]);setAuth(false);setNotice('');}catch(e){setError(e instanceof Error?e.message:'Unable to lock.');}finally{setBusy(false);}}
 const shown=useMemo(()=>books.filter(book=>(filter==='all'||book.status===filter)&&`${book.title} ${book.author} ${book.isbn} ${book.slug}`.toLowerCase().includes(query.toLowerCase())),[books,filter,query]);
 const drafts=books.filter(b=>b.status==='draft').length;
 function saved(book:InventoryBook){setBooks(current=>current.map(b=>b.id===book.id?book:b));setSelected(null);setNotice(`“${book.title}” ${book.status==='published'?'is published.':'saved as a draft.'}`);}
 function deleted(book: InventoryBook) {
  setBooks(current => current.filter(item => item.id !== book.id));
  setSelected(null);
  setNotice(`“${book.title}” was deleted.`);
 }

 if(auth===null)return <div className="mx-auto max-w-6xl px-6 py-20 text-ink/60" role="status">Opening inventory…</div>;
 if(!auth)return <div className="mx-auto max-w-md px-5 py-16 sm:py-24"><p className="text-xs uppercase tracking-[0.2em] text-accent">Folio / Studio</p><h1 className="mt-4 font-display text-4xl">A little shelf keeping.</h1><p className="mt-4 text-sm leading-relaxed text-ink/60">Manage your drafts, set prices, and prepare books for the shop.</p><form onSubmit={unlock} className="mt-8 rounded-2xl border border-ink/10 bg-white/60 p-6"><label className="text-sm font-medium" htmlFor="inventory-pin">Inventory PIN</label><input id="inventory-pin" className={field} type="password" autoComplete="current-password" value={pin} onChange={e=>setPin(e.target.value)} required maxLength={128}/><p className="mt-2 text-xs text-ink/50">Enter your admin access code.</p>{error&&<p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}<button className={`${primary} mt-5 w-full`} disabled={busy}>{busy?'Unlocking…':'Unlock inventory'}</button></form><Link className="mt-6 inline-block text-sm text-ink/60 hover:text-accent" href="/">← Back to the bookstore</Link></div>;

 return <div className="mx-auto w-full max-w-6xl px-4 py-9 sm:px-6 sm:py-12">
  <div className="flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs uppercase tracking-[0.2em] text-accent">Folio / Studio</p><h1 className="mt-3 font-display text-4xl sm:text-5xl">Your inventory.</h1><p className="mt-3 text-sm text-ink/60">A place to prepare every book for its next reader.</p></div><button onClick={lock} disabled={busy} className="rounded-full border border-ink/15 px-4 py-2 text-sm hover:border-accent">Lock inventory</button></div>
  <div className="mt-8 grid grid-cols-3 gap-3 sm:gap-5">{[{label:'All books',value:books.length},{label:'In drafts',value:drafts},{label:'Published',value:books.length-drafts}].map(stat=><div key={stat.label} className="rounded-xl border border-ink/10 bg-white/50 px-4 py-4 sm:px-6"><p className="text-xs text-ink/60">{stat.label}</p><p className="mt-2 font-display text-3xl">{stat.value}</p></div>)}</div>
  <div className="mt-7 flex items-start gap-3 rounded-xl bg-parchment/70 p-4 text-sm leading-relaxed text-ink/70"><span aria-hidden="true" className="font-display text-xl text-accent">i</span><p>Drafts are only visible here. Review the author and set a price in PKR before publishing. Stock shows copies available to sell, excluding checkout holds.</p></div>
  {error&&<p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}{notice&&<p role="status" className="mt-4 rounded-lg bg-green-50 p-3 text-sm text-accent">{notice}</p>}
  <div className="mt-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div role="group" aria-label="Book status" className="flex gap-1 rounded-full border border-ink/10 bg-white/50 p-1 self-start">{(['draft','published','all'] as Filter[]).map(tab=><button key={tab} onClick={()=>setFilter(tab)} aria-pressed={filter===tab} className={`rounded-full px-4 py-2 text-sm ${filter===tab?'bg-ink text-cream':'text-ink/60 hover:text-ink'}`}>{tab==='all'?'All books':tab==='draft'?'Drafts':'Published'}</button>)}</div><div className="flex items-center gap-3"><label className="sr-only" htmlFor="inventory-search">Search inventory</label><input id="inventory-search" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search title, author, or ISBN" className="w-full rounded-full border border-ink/15 bg-white/60 px-4 py-2.5 text-sm sm:w-72"/><button onClick={()=>{setError('');void load();}} disabled={loading} className="text-sm text-accent disabled:opacity-40">Refresh</button></div></div>
  <div className="mt-5 overflow-hidden rounded-xl border border-ink/10 bg-white/40"><div className="hidden grid-cols-[1fr_100px_90px_110px_72px] gap-4 border-b border-ink/10 bg-parchment/40 px-5 py-3 text-xs uppercase tracking-wider text-ink/50 md:grid"><span>Book / edition</span><span>Price · PKR</span><span>Available</span><span>Status</span><span></span></div>
   {loading&&books.length===0?<p className="p-12 text-center text-sm text-ink/60" role="status">Loading your books…</p>:shown.length===0?<div className="px-6 py-16 text-center"><h2 className="font-display text-2xl">{query?'No matching books.':filter==='draft'?'Your drafts are clear.':'No books here yet.'}</h2><p className="mt-2 text-sm text-ink/60">{query?'Try another title, author, or ISBN.':'New books received through Discord appear in drafts.'}</p></div>:shown.map(book=><div key={book.id} className="grid items-center gap-4 border-b border-ink/10 p-4 last:border-0 sm:p-5 md:grid-cols-[1fr_100px_90px_110px_72px]"><div className="flex min-w-0 gap-4"><BookCover src={book.coverUrl} title={book.title} className="h-20 w-14 shrink-0 rounded-sm" sizes="56px"/><div className="min-w-0 self-center"><h2 className="truncate font-display text-lg">{book.title}</h2><p className="truncate text-sm text-ink/60">{book.author}</p><p className="mt-1 truncate font-mono text-[11px] text-ink/40">{book.isbn.startsWith('manual-')?'ISBN not linked':book.isbn}</p></div></div><div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm md:contents"><span className={book.priceCents===0?'text-amber-800':''}>{book.priceCents>0?formatPrice(book.priceCents):'Price needed'}</span><span><span className="text-ink/50 md:hidden">Available: </span>{book.stock}</span><span className={`w-fit rounded-full px-2.5 py-1 text-xs ${book.status==='draft'?'bg-amber-100/70 text-amber-900':'bg-green-100/70 text-accent'}`}>{book.status==='draft'?'Draft':'Published'}</span><button className="ml-auto rounded-full border border-ink/15 px-4 py-2 text-sm hover:border-accent hover:text-accent md:ml-0" aria-label={`Edit ${book.title}`} onClick={()=>{setSelected(book);setNotice('');}}>Edit</button></div></div>)}
  </div><p className="mt-4 text-xs text-ink/45">{shown.length} {shown.length===1?'book':'books'} shown · Prices in Pakistani rupees</p>
  {selected&&<BookEditor key={selected.id} book={selected} onClose={()=>setSelected(null)} onSaved={saved} onDeleted={deleted} onExpired={()=>{setAuth(false);setSelected(null);}}/>}
 </div>;
}

function BookEditor({book,onClose,onSaved,onDeleted,onExpired}:{book:InventoryBook;onClose:()=>void;onSaved:(book:InventoryBook)=>void;onDeleted:(book:InventoryBook)=>void;onExpired:()=>void}){
 const [confirmDelete, setConfirmDelete] = useState(false);
 const [deleteError, setDeleteError] = useState("");
 const [title,setTitle]=useState(book.title),[author,setAuthor]=useState(book.author),[description,setDescription]=useState(book.description),[price,setPrice]=useState((book.priceCents/100).toFixed(2)),[stock,setStock]=useState(String(book.stock)),[status,setStatus]=useState(book.status),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const previous=document.body.style.overflow;document.body.style.overflow='hidden';const element=document.getElementById('edit-title');element?.focus();return()=>{document.body.style.overflow=previous;};},[]);
 async function save(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{const res=await fetch('/api/admin/books',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:book.id,title,author,description,price,stock:Number(stock),status,expected:book})});const data=await res.json();if(res.status===401){onExpired();return;}if(!res.ok)throw Error(data.error);onSaved(data.book);}catch(e){setError(e instanceof Error?e.message:'Unable to save.');}finally{setBusy(false);}}
 async function removeBook() {
  setBusy(true);
  setDeleteError("");
  try {
   const response = await fetch("/api/admin/books", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected: book }),
   });
   if (response.status === 401) { onExpired(); return; }
   const data = await response.json();
   if (!response.ok) throw new Error(data.error);
   onDeleted(book);
  } catch (error) {
   setDeleteError(error instanceof Error ? error.message : "Unable to delete this book.");
  } finally {
   setBusy(false);
  }
 }
 return <div className="fixed inset-0 z-40 flex justify-end bg-ink/35 backdrop-blur-sm" onKeyDown={e=>{if(e.key==='Escape'&&!busy)onClose();if(e.key==='Tab'){const controls=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,select'));const first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}}><section role="dialog" aria-modal="true" aria-labelledby="edit-heading" className="h-full w-full max-w-xl overflow-y-auto bg-cream p-5 shadow-xl sm:p-8"><div className="flex items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-[0.2em] text-accent">Book details</p><h2 id="edit-heading" className="mt-3 font-display text-3xl">Prepare for the shelf.</h2></div><button type="button" onClick={onClose} disabled={busy} className="rounded-full border border-ink/15 px-3 py-2 text-sm" aria-label="Close book editor">✕</button></div><p className="mt-3 text-xs text-ink/50">ISBN: {book.isbn} · /books/{book.slug}</p>
 <form onSubmit={save} className="mt-7 space-y-5">
  <label className="block text-sm font-medium" htmlFor="edit-title">Title<input id="edit-title" className={field} value={title} onChange={e=>setTitle(e.target.value)} required maxLength={300}/></label>
  <label className="block text-sm font-medium" htmlFor="edit-author">Author<input id="edit-author" className={field} value={author} onChange={e=>setAuthor(e.target.value)} required maxLength={300}/></label>
  <div className="grid grid-cols-2 gap-4"><label className="block text-sm font-medium" htmlFor="edit-price">Price · PKR<input id="edit-price" className={field} type="number" min="0" max="1000000" step="0.01" value={price} onChange={e=>setPrice(e.target.value)} required/><span className="mt-1 block text-xs font-normal text-ink/50">Enter rupees, e.g. 1,500.</span></label><label className="block text-sm font-medium" htmlFor="edit-stock">Available copies<input id="edit-stock" className={field} type="number" min="0" max="1000000" step="1" value={stock} onChange={e=>setStock(e.target.value)} required/><span className="mt-1 block text-xs font-normal text-ink/50">Excludes active checkout holds.</span></label></div>
  <label className="block text-sm font-medium" htmlFor="edit-description">Description<textarea id="edit-description" rows={5} className={`${field} resize-y`} value={description} onChange={e=>setDescription(e.target.value)} maxLength={10000}/></label>
  <label className="block text-sm font-medium" htmlFor="edit-status">Visibility<select id="edit-status" className={field} value={status} onChange={e=>setStatus(e.target.value)}><option value="draft">Draft — only visible in inventory</option><option value="published">Published — visible in the shop</option></select></label>
  {status==='published'&&<p className="rounded-lg bg-parchment p-3 text-xs leading-relaxed text-ink/60">Publishing makes this edition available in the shop. Check its author, price, and stock before saving.</p>}
  {error&&<p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
  <div className="flex gap-3 border-t border-ink/10 pt-5"><button className={primary} disabled={busy}>{busy?'Saving…':status==='published'?'Save & publish':'Save draft'}</button><button className="rounded-full border border-ink/15 px-5 py-2.5 text-sm" type="button" onClick={onClose} disabled={busy}>Cancel</button></div>
 </form>
 <div className="mt-7 border-t border-ink/10 pt-5">
  <button type="button" disabled={busy} aria-expanded={confirmDelete} aria-controls="delete-book-confirmation" onClick={() => { setConfirmDelete(!confirmDelete); setDeleteError(""); }} className="text-sm font-medium text-red-700 hover:underline disabled:opacity-50">
   {confirmDelete ? "Cancel deletion" : "Delete book"}
  </button>
  {confirmDelete && <div id="delete-book-confirmation" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-4">
   <p className="text-sm text-red-950">Permanently delete “{book.title}” from inventory? This removes all {book.stock} available copies.</p>
   {deleteError && <p role="alert" className="mt-3 text-sm text-red-700">{deleteError}</p>}
   <button type="button" disabled={busy} onClick={removeBook} className="mt-4 rounded-full bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50">Confirm deletion</button>
  </div>}
 </div>
 </section></div>;
}
