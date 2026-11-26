import { createHash } from "node:crypto";
import type { CoverLine } from "./cover-ocr";
import { normalizeCoverText, type CoverCandidate } from "./cover-catalogs";
import { boundedFetch, coverDistance, readingsCovers } from "./publisher-cover";
import type { EditionCandidate } from "./edition-types";
import { canonicalIsbn } from "./isbn";
import {coverTitleVariants} from "./cover-catalog-titles";

const noise = /\b(winner|prize|bestsell(?:er|ing)?|award|million|copyright|published|edition|anniversary|introduction|translated|foreword|penguin|classics|readings)\b/i;
const words = (value: string) => normalizeCoverText(value).split(" ").filter(word => word.length >= 3);
const meaningful = (value: string) => words(value).filter(word => !["the", "and", "for", "with", "from", "all"].includes(word));
export function partialCoverQueries(lines: CoverLine[]) {
  const rows = lines.map(line=>({...line,text:line.text.replace(/^(?:(?:a|the)\s+)?(?:novel|book)\s+by\s+|^by\s+/i,"").trim()}))
    .filter(line => (line.confidence ?? 0) >= 70 && line.height >= 0.015 && line.height <= 0.35 && !noise.test(line.text) &&
      line.text.length <= 120 && meaningful(line.text).length > 0 && words(line.text).length <= 8);
  const ranked=new Map<string,number>();
  for(const row of rows){
    const query=words(row.text).join(" "),score=row.height*((row.confidence??0)/100)**4;
    ranked.set(query,Math.max(score,ranked.get(query)??0));
  }
  // Join adjacent single-word rows, e.g. a stacked author name. Never repair spelling or invent missing words.
  for(const first of rows)for(const second of rows){
    if(first.top===undefined||second.top===undefined||words(first.text).length!==1||words(second.text).length!==1||
      (first.confidence??0)<80||(second.confidence??0)<80||first.top>=second.top||
      second.top-first.top<Math.min(first.height,second.height)*.25||second.top-first.top>Math.max(first.height,second.height)*1.3||
      Math.min(first.height,second.height)/Math.max(first.height,second.height)<.5)continue;
    const query=[...words(first.text),...words(second.text)].join(" ");
    const score=(first.height+second.height)*.6*(Math.min(first.confidence??0,second.confidence??0)/100)**4;
    ranked.set(query,Math.max(score,ranked.get(query)??0));
  }
  const ordered=[...ranked].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  // Prefer the full visible phrase over a redundant single-word fragment from the same lettering.
  const prominent=ordered.filter(([query,score])=>!ordered.some(([other,otherScore])=>other!==query&&otherScore>=score&&
    query.split(" ").every(word=>other.split(" ").includes(word)))).slice(0,4).map(([query])=>query);
  // Preserve high-confidence small author lettering alongside large title/author evidence.
  const confident=[...new Set([...rows].sort((a,b)=>(b.confidence??0)-(a.confidence??0)).map(row=>words(row.text).join(" ")))];
  return [...new Set([...prominent,...confident.slice(0,4)])].slice(0,8);
}
// Partial text is search evidence only: it never becomes an automatic work/ISBN match.
export function supportsSuggestion(candidate: CoverCandidate, queries: string[]) {
  const author = meaningful(candidate.author), title = meaningful(candidate.title).filter(word=>!author.includes(word));
  return queries.some((query,i) => meaningful(query).some(word => title.includes(word)) &&
    queries.some((other,j) => i!==j && meaningful(other).some(word => author.includes(word))));
}
function fullAuthorVisible(candidate:CoverCandidate,queries:string[]) {
  const author=normalizeCoverText(candidate.author);
  return meaningful(author).length>=2&&queries.some(query=>normalizeCoverText(query)===author);
}
export function visibleAuthorAllows(author:string,lines:CoverLine[]) {
  const parts=normalizeCoverText(author).split(" ");
  const clues=lines.filter(line=>(line.confidence??0)>=85).flatMap(line=>{
    const text=line.text.replace(/^(?:(?:a|the)\s+)?(?:novel|book)\s+by\s+|^by\s+/i,"").trim();
    const match=/^((?:[A-Z](?:\.\s*|\s+)){1,3})([\p{L}-]{3,})$/u.exec(text);
    if(!match)return [];
    const surname=normalizeCoverText(match[2]);if(!parts.includes(surname))return [];
    return [{surname,initials:match[1].replace(/[^A-Z]/g,"").toLowerCase()}];
  });
  const size=Math.max(0,...clues.map(clue=>clue.initials.length));
  return !size||clues.filter(clue=>clue.initials.length===size).some(clue=>
    parts.filter(part=>part!==clue.surname).map(part=>part[0]).join("").startsWith(clue.initials));
}
const titleKey=(candidate:CoverCandidate)=>coverTitleVariants(candidate.title.replace(/\s*\([^)]*\)\s*$/,""),candidate.author)
  .map(variant=>variant.text.replace(/^(the|a|an) /,"")).sort((a,b)=>a.length-b.length)[0]??"";
type Dependencies = {
  deadlineMs?:number;
  search(query: string, signal: AbortSignal): Promise<CoverCandidate[]>;
  discover?(queries: string[], signal: AbortSignal): Promise<CoverCandidate[]>;
  read(url: string, signal: AbortSignal, maxBytes: number): Promise<Buffer>;
  compare(image: Buffer, reference: Buffer): Promise<{gray: number; color: number; score: number}>;
};
export async function discoverPartialWorks(queries: string[], signal: AbortSignal): Promise<CoverCandidate[]> {
  const searches=await Promise.allSettled(Array.from({length:2+Math.min(queries.length,4)},(_,i)=>i).map(async i=>{
    const params=new URLSearchParams({...(i<2?{title:queries[i],author:queries[1-i]}:{author:queries[i-2]}),limit:"6",fields:"key,title,author_name,cover_i"});
    return JSON.parse((await boundedFetch(`https://openlibrary.org/search.json?${params}`,signal,512_000)).toString()) as {docs?:{key?:unknown;cover_i?:unknown;title?:unknown;author_name?:unknown}[]};
  }));
  const works=searches.flatMap(result=>result.status==="fulfilled"?(result.value.docs??[]).slice(0,6):[]).filter(row=>typeof row.title==="string" && row.title.length<=200 &&
    Array.isArray(row.author_name) && row.author_name.some(name=>typeof name==="string" &&
      supportsSuggestion({title:row.title as string,author:name,publisher:"",coverUrl:"",source:"",catalog:"",identity:""},queries)));
  const covers:CoverCandidate[]=works.flatMap(row=>{
    if(typeof row.key!=="string"||!/^\/works\/OL\d+W$/.test(row.key)||!Number.isSafeInteger(row.cover_i)||Number(row.cover_i)<=0)return [];
    const author=(row.author_name as string[]).find(name=>typeof name==="string"&&supportsSuggestion({title:row.title as string,author:name,publisher:"",coverUrl:"",source:"",catalog:"",identity:""},queries))!;
    return [{title:row.title as string,author,publisher:"",coverUrl:`https://covers.openlibrary.org/b/id/${row.cover_i}-L.jpg?default=false`,
      source:`https://openlibrary.org${row.key}`,catalog:"Open Library work catalog",identity:`work:${row.key}`}];
  });
  const titles=[...new Set(works.map(row=>row.title as string))].slice(0,3);
  const results=await Promise.allSettled(titles.map(title=>readingsCovers({title},signal)));
  return [...covers,...results.flatMap(result=>result.status==="fulfilled"?result.value:[])];
}
function trustedSuggestion(candidate:CoverCandidate) {
  return /^https:\/\/d9z6htgewkjtb\.cloudfront\.net\/97[89]\d{10}\.webp$/.test(candidate.coverUrl)&&/^https:\/\/readings\.com\.pk\/book\/\d+$/.test(candidate.source)||
    /^https:\/\/covers\.openlibrary\.org\/b\/id\/[1-9]\d*-L\.jpg\?default=false$/.test(candidate.coverUrl)&&/^https:\/\/openlibrary\.org\/works\/OL\d+W$/.test(candidate.source);
}
const defaults: Dependencies = { search: (title,signal) => readingsCovers({title},signal), discover:discoverPartialWorks,read: boundedFetch, compare: coverDistance };
export async function suggestCoverCandidates(image: Buffer, lines: CoverLine[], deps: Dependencies = defaults): Promise<EditionCandidate[]> {
  const queries = partialCoverQueries(lines);
  if (!queries.length) return [];
  const deadlineMs=Math.min(12_000,Math.max(10,deps.deadlineMs??12_000));
  const signal = AbortSignal.timeout(deadlineMs);
  // Race the full job too: an unresponsive dependency cannot delay the retained-cover response forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const compared:{candidate:CoverCandidate;gray:number;color:number;score:number;partial:boolean}[]=[];
  const rank=()=>compared.filter(match=>match.partial?((match.gray<=.22&&match.color<=.22)||(match.gray<=.32&&match.color<=.18)):
    match.gray<=.12&&match.color<=.12)
      .filter((match,_,eligible)=>!eligible.some(other=>other!==match&&other.score<=match.score&&
        normalizeCoverText(other.candidate.author)===normalizeCoverText(match.candidate.author)&&titleKey(other.candidate)&&
        titleKey(match.candidate).startsWith(titleKey(other.candidate)+" ")))
      .sort((a,b)=>a.score-b.score).slice(0,3).map(({candidate,gray,color,partial})=>({
        id: createHash("sha256").update(candidate.source).digest("hex").slice(0,24), title:candidate.title,author:candidate.author,
        publisher:candidate.publisher,coverUrl:candidate.coverUrl,source:candidate.source,catalog:candidate.catalog,
        isbn:canonicalIsbn(candidate.identity.replace(/^isbn:/,"")),matchQuality:gray<=0.16&&color<=0.16?"close" as const:"possible" as const,
        identityEvidence:partial?"partial-title-author" as const:"author-and-artwork" as const,
      }));
  const unique=new Set<string>();
  let authorOnlyComparisons=0;
  const job=Promise.allSettled([...queries.map(query=>deps.search(query,signal)),...(deps.discover&&queries.length>=2?[deps.discover(queries,signal)]:[])]
    .map(async source=>{
      const results=await source;
      // Start artwork comparisons as each catalog finishes; a slow source cannot discard completed matches.
      await Promise.allSettled(results.slice(0,30).map(async candidate=>{
        const partial=supportsSuggestion(candidate,queries);
        if(signal.aborted||unique.has(candidate.source)||unique.size>=12||(!partial&&!fullAuthorVisible(candidate,queries))||!visibleAuthorAllows(candidate.author,lines)||
          candidate.title.length>200||candidate.author.length>140||/[\p{Cc}\p{Cf}]/u.test(candidate.title+candidate.author)||!trustedSuggestion(candidate))return;
        // Keep most of the bounded image budget available for independent title+author evidence.
        if(!partial&&authorOnlyComparisons>=3)return;
        if(!partial)authorOnlyComparisons++;
        unique.add(candidate.source);
        const reference=await deps.read(candidate.coverUrl,signal,2_000_000);
        const match=await deps.compare(image,reference);
        if(!signal.aborted)compared.push({candidate,...match,partial});
      }));
    })).then(rank);
  try { return await Promise.race([job,new Promise<EditionCandidate[]>(resolve => {timer=setTimeout(()=>resolve(rank()),deadlineMs);})]); }
  finally { clearTimeout(timer); }
}
