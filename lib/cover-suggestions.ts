import { createHash } from "node:crypto";
import type { CoverLine } from "./cover-ocr";
import { normalizeCoverText, type CoverCandidate } from "./cover-catalogs";
import { boundedFetch, coverDistance, readingsCovers } from "./publisher-cover";
import type { EditionCandidate } from "./edition-types";
import { canonicalIsbn } from "./isbn";

const noise = /\b(winner|prize|bestsell|award|million|copyright|published|edition|introduction|translated|foreword|penguin|classics|readings)\b/i;
const words = (value: string) => normalizeCoverText(value).split(" ").filter(word => word.length >= 3);
const meaningful = (value: string) => words(value).filter(word => !["the", "and", "for", "with", "from", "all"].includes(word));
export function partialCoverQueries(lines: CoverLine[]) {
  const rows = lines.filter(line => (line.confidence ?? 0) >= 70 && line.height >= 0.015 && !noise.test(line.text) &&
    line.text.length <= 120 && words(line.text).length > 0 && words(line.text).length <= 8)
    .sort((a,b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  return [...new Set(rows.map(line => words(line.text).join(" ")))].slice(0, 4);
}
// Partial text is search evidence only: it never becomes an automatic work/ISBN match.
export function supportsSuggestion(candidate: CoverCandidate, queries: string[]) {
  const title = meaningful(candidate.title), author = meaningful(candidate.author);
  return queries.some((query,i) => meaningful(query).some(word => title.includes(word)) &&
    queries.some((other,j) => i!==j && meaningful(other).some(word => author.includes(word))));
}
type Dependencies = {
  search(query: string, signal: AbortSignal): Promise<CoverCandidate[]>;
  discover?(queries: string[], signal: AbortSignal): Promise<CoverCandidate[]>;
  read(url: string, signal: AbortSignal, maxBytes: number): Promise<Buffer>;
  compare(image: Buffer, reference: Buffer): Promise<{gray: number; color: number; score: number}>;
};
export async function discoverPartialWorks(queries: string[], signal: AbortSignal): Promise<CoverCandidate[]> {
  const searches=await Promise.allSettled([0,1].map(async i=>{
    const params=new URLSearchParams({title:queries[i],author:queries[1-i],limit:"6",fields:"title,author_name"});
    return JSON.parse((await boundedFetch(`https://openlibrary.org/search.json?${params}`,signal,512_000)).toString()) as {docs?:{title?:unknown;author_name?:unknown}[]};
  }));
  const works=searches.flatMap(result=>result.status==="fulfilled"?(result.value.docs??[]).slice(0,6):[]).filter(row=>typeof row.title==="string" && row.title.length<=200 &&
    Array.isArray(row.author_name) && row.author_name.some(name=>typeof name==="string" &&
      supportsSuggestion({title:row.title as string,author:name,publisher:"",coverUrl:"",source:"",catalog:"",identity:""},queries))).slice(0,3);
  const results=await Promise.allSettled(works.map(row=>readingsCovers({title:row.title as string},signal)));
  return results.flatMap(result=>result.status==="fulfilled"?result.value:[]);
}
const defaults: Dependencies = { search: (title,signal) => readingsCovers({title},signal), discover:discoverPartialWorks,read: boundedFetch, compare: coverDistance };
export async function suggestCoverCandidates(image: Buffer, lines: CoverLine[], deps: Dependencies = defaults): Promise<EditionCandidate[]> {
  const queries = partialCoverQueries(lines);
  if (queries.length < 2) return [];
  const signal = AbortSignal.timeout(12_000);
  // Race the full job too: an unresponsive dependency cannot delay the retained-cover response forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const job = (async () => {
    const results = await Promise.allSettled([...queries.map(query => deps.search(query,signal)),...(deps.discover?[deps.discover(queries,signal)]:[])]);
    const unique = new Map<string,CoverCandidate>();
    for (const result of results) if (result.status === "fulfilled") for (const candidate of result.value.slice(0,30)) {
      if (supportsSuggestion(candidate,queries) && candidate.title.length <= 200 && candidate.author.length <= 140 &&
        !/[\p{Cc}\p{Cf}]/u.test(candidate.title+candidate.author) &&
        /^https:\/\/d9z6htgewkjtb\.cloudfront\.net\/97[89]\d{10}\.webp$/.test(candidate.coverUrl) &&
        /^https:\/\/readings\.com\.pk\/book\/\d+$/.test(candidate.source)) unique.set(candidate.source,candidate);
    }
    const compared = await Promise.allSettled([...unique.values()].slice(0,12).map(async candidate => {
      const reference = await deps.read(candidate.coverUrl,signal,2_000_000);
      const match = await deps.compare(image,reference);
      return {candidate,...match};
    }));
    return compared.flatMap(result => result.status === "fulfilled" ? [result.value] : [])
      .filter(match => (match.gray <= 0.22 && match.color <= 0.22) || (match.gray <= 0.32 && match.color <= 0.18))
      .sort((a,b) => a.score-b.score).slice(0,3).map(({candidate,gray,color}) => ({
        id: createHash("sha256").update(candidate.source).digest("hex").slice(0,24), title:candidate.title,author:candidate.author,
        publisher:candidate.publisher,coverUrl:candidate.coverUrl,source:candidate.source,catalog:candidate.catalog,
        isbn:canonicalIsbn(candidate.identity.replace(/^isbn:/,"")),matchQuality:gray<=0.16&&color<=0.16?"close" as const:"possible" as const,
      }));
  })();
  try { return await Promise.race([job,new Promise<EditionCandidate[]>(resolve => {timer=setTimeout(()=>resolve([]),12_000);})]); }
  finally { clearTimeout(timer); }
}
