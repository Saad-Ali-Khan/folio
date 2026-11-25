import {readFileSync,writeFileSync} from "node:fs";
import {suggestCoverCandidates,partialCoverQueries} from "../../lib/cover-suggestions";
import {normalizeCoverText} from "../../lib/cover-catalogs";
import type {CoverLine} from "../../lib/cover-ocr";
import {boundedFetch} from "../../lib/publisher-cover";
const read=(name:string)=>JSON.parse(readFileSync(`.folio-ocr/${name}.json`,"utf8"));
async function main(){
  const probes=await Promise.allSettled([
    boundedFetch("https://openlibrary.org/search.json?title=book&limit=1&fields=key",AbortSignal.timeout(8000),512000),
    boundedFetch("https://htk3x7p5jf.ap-south-1.awsapprunner.com/api/autocomplete?search=book",AbortSignal.timeout(8000),512000),
  ]);
  const catalogAvailability={openLibrary:probes[0].status,readings:probes[1].status};
  if(probes.every(probe=>probe.status==="rejected"))throw Error("Catalog access unavailable; previous comparison report preserved. No recognition result can be measured.");
  const cases=read("cases") as {id:string;image:string;expectedTitle:string;expectedAuthor:string;group:string}[];
  const policy=read("comparison-geometry").rows as {sample:string;engine:string;catalog:string}[];
  const mobile=read("paddle").cases as {id:string;lines:CoverLine[]}[];
  const tesseract=read("tesseract").cases as {id:string;lines:CoverLine[]}[];
  const crops=read("paddle-geometry").cases as {id:string;lines:CoverLine[]}[];
  const rows=[];
  for(const sample of cases){
    const baseline=policy.find(row=>row.sample===sample.id&&row.engine.startsWith("Fallback policy:"));
    if(baseline?.catalog==="correct"){rows.push({sample:sample.id,group:sample.group,status:"automatic success unchanged"});continue;}
    const lines=[...(mobile.find(row=>row.id===sample.id)?.lines??[]),...(tesseract.find(row=>row.id===sample.id)?.lines??[]),...(crops.find(row=>row.id===sample.id)?.lines??[])];
    const suggestions=await suggestCoverCandidates(readFileSync(`.folio-ocr/${sample.image}`),lines);
    const expected=normalizeCoverText(sample.expectedTitle),author=normalizeCoverText(sample.expectedAuthor);
    const exact=suggestions.every(candidate=>normalizeCoverText(candidate.title.replace(/\s*\([^)]*\)\s*$/,"") )===expected&&normalizeCoverText(candidate.author)===author);
    const row={sample:sample.id,group:sample.group,queries:partialCoverQueries(lines),status:suggestions.length?(exact?"correct review suggestion":"review suggestions need inspection"):"no suggestion",suggestions};rows.push(row);
    console.log(sample.id,row.status);
    writeFileSync(".folio-ocr/suggestions-review.json",JSON.stringify({complete:false,catalogAvailability,rows},null,2));
  }
  writeFileSync(".folio-ocr/suggestions-review.json",JSON.stringify({complete:true,catalogAvailability,rows},null,2));
  console.table(rows.map(({sample,group,status})=>({sample,group,status})));
  console.log("Read-only catalog replay from saved OCR; successful automatic matches preserved. Suggestions always require operator confirmation. No stock or messages changed.");
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
