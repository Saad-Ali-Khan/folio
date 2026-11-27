import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import type {LocatedLine} from '../../lib/cover-geometry';
import {callLocalOcr,localOcrHealth} from '../../lib/local-ocr-client';
import {supportsTextOnlyReview,suggestCoverCandidates} from '../../lib/cover-suggestions';
import {adjacentReviewRows,contrastReviewView} from './contrast-review';

type Sample={id:string;image:string;sha256:string;expectedTitle:string;expectedAuthor:string;expectedTitleAliases?:string[];expectedAuthorAliases?:string[];group:string};
type Scan={id:string;variant:'control'|'green';ocrMs:number;preprocessMs:number;lines:LocatedLine[]};
const read=(name:string)=>JSON.parse(readFileSync(`.folio-ocr/${name}.json`,'utf8'));
const normalize=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
async function main(){
 const manifest=readFileSync('.folio-ocr/cases.json'),samples=JSON.parse(manifest.toString()) as Sample[];
 if(samples.length<1||samples.length>100)throw Error('Invalid corpus size');
 const sources=['paddle','tesseract','paddle-geometry'].map(read);
 if(sources.some((source,i)=>(i!==1&&!source.complete)||source.datasetHash!==hash(manifest)||
  samples.some(sample=>!source.cases.some((row:{id:string;error?:string})=>row.id===sample.id&&!row.error))))throw Error('Incomplete or stale saved OCR');
 if(!(await localOcrHealth()).ready)throw Error('Local OCR is not ready');
 const scans:Scan[]=[];const rows:Record<string,unknown>[]=[];
 const save=(complete=false)=>writeFileSync('.folio-ocr/contrast-benchmark.json',JSON.stringify({complete,generatedAt:new Date().toISOString(),datasetHash:hash(manifest),
  policy:'EXPERIMENT ONLY: saved stages plus fresh same-size RGB control/green channel and adjacent-row composition. No automatic import changes.',scans,rows},null,2));
 for(const sample of samples){
  const image=readFileSync(`.folio-ocr/${sample.image}`);if(hash(image)!==sample.sha256)throw Error(`Input changed: ${sample.id}`);
  for(const variant of ['control','green'] as const){
   const start=performance.now(),view=await contrastReviewView(image,variant==='green'),preprocessMs=Math.round(performance.now()-start);
   const inferenceStart=performance.now(),result=await callLocalOcr(view,'detect');
   scans.push({id:sample.id,variant,preprocessMs,ocrMs:Math.round(performance.now()-inferenceStart),lines:result.lines??[]});save();
  }
  console.log(`OCR ${scans.length/2}/${samples.length}: ${sample.id}`);
 }
 const observed=(sample:Sample,green:boolean)=>[...sources.flatMap(source=>source.cases.find((row:{id:string})=>row.id===sample.id)?.lines??[]),
  ...scans.filter(scan=>scan.id===sample.id&&(green||scan.variant==='control')).flatMap(scan=>scan.lines)];
 const candidate=(sample:Sample)=>({title:sample.expectedTitle,author:sample.expectedAuthor,publisher:'',coverUrl:'',source:'',catalog:'',identity:''});
 const sameWork=(sample:Sample,title:string,author:string)=>[sample.expectedTitle,...sample.expectedTitleAliases??[]].some(t=>normalize(t)===normalize(title.replace(/\s*\([^)]*\)\s*$/,'')))&&
  [sample.expectedAuthor,...sample.expectedAuthorAliases??[]].some(a=>normalize(a)===normalize(author));
 // Label fixtures are used for evaluation only, never for selecting crops or queries.
 for(const sample of samples){
  const control=observed(sample,false),green=observed(sample,true),combined=adjacentReviewRows(green);
  const wrong=samples.filter(other=>!sameWork(sample,other.expectedTitle,other.expectedAuthor)&&supportsTextOnlyReview(candidate(other),combined)).map(other=>other.id);
  rows.push({sample:sample.id,group:sample.group,
   exactWorkEvidenceControl:supportsTextOnlyReview(candidate(sample),control),
   exactWorkEvidenceJoinedControl:supportsTextOnlyReview(candidate(sample),adjacentReviewRows(control)),
   exactWorkEvidenceGreen:supportsTextOnlyReview(candidate(sample),green),
   exactWorkEvidenceGreenJoined:supportsTextOnlyReview(candidate(sample),combined),wrongWorkEvidence:wrong});
 }
 save();
 const prior=read('comparison-geometry').rows as {sample:string;engine:string;catalog:string}[];
 const originalFetch=globalThis.fetch;
 try{
  for(const sample of samples){
   const row=rows.find(row=>row.sample===sample.id)!;
   if(prior.some(p=>p.sample===sample.id&&p.engine.startsWith('Fallback policy:')&&p.catalog==='correct')){
    row.catalog='earlier automatic success preserved by stage ordering; not remeasured';save();continue;
   }
   let metadataOk=0,metadataFailed=0;
   globalThis.fetch=async(input,init)=>{
    if(init?.method&&init.method!=='GET')throw Error('Benchmark allows reads only');
    const url=new URL(String(input)),metadata=url.pathname.includes('/api/')||url.pathname==='/search.json';
    try{const response=await originalFetch(input,init);if(metadata){if(response.ok)metadataOk++;else metadataFailed++;}return response;}
    catch(error){if(metadata)metadataFailed++;throw error;}
   };
   const started=performance.now();
   const proposals=await suggestCoverCandidates(readFileSync(`.folio-ocr/${sample.image}`),adjacentReviewRows(observed(sample,true)));
   row.reviewMs=Math.round(performance.now()-started);row.metadataOk=metadataOk;row.metadataFailed=metadataFailed;row.proposals=proposals;
   row.catalog=proposals.length?(proposals.every(p=>sameWork(sample,p.title,p.author))?'correct review proposal':'REVIEW_MISMATCH'):
    !metadataOk&&metadataFailed?'catalog unavailable':'no proposal';
   console.log(`Review ${sample.id}: ${row.catalog}`);save();
  }
 }finally{globalThis.fetch=originalFetch;}
 save(true);
 console.table(rows.map(({sample,exactWorkEvidenceControl,exactWorkEvidenceJoinedControl,exactWorkEvidenceGreen,exactWorkEvidenceGreenJoined,catalog})=>
  ({sample,control:exactWorkEvidenceControl,joined:exactWorkEvidenceJoinedControl,green:exactWorkEvidenceGreen,greenJoined:exactWorkEvidenceGreenJoined,catalog})));
 const median=(values:number[])=>{const sorted=values.toSorted((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
 console.log(JSON.stringify({cases:samples.length,crossWorkFalseEvidence:rows.filter(r=>(r.wrongWorkEvidence as unknown[]).length).length,
  controlMedianMs:median(scans.filter(s=>s.variant==='control').map(s=>s.ocrMs+s.preprocessMs)),
  addedGreenMedianMs:median(scans.filter(s=>s.variant==='green').map(s=>s.ocrMs+s.preprocessMs)),
  correctReview:rows.filter(r=>r.catalog==='correct review proposal').length,mismatches:rows.filter(r=>r.catalog==='REVIEW_MISMATCH').length,
  unresolved:rows.filter(r=>r.catalog==='no proposal').length,catalogUnavailable:rows.filter(r=>r.catalog==='catalog unavailable').length}));
 console.log('Private report: .folio-ocr/contrast-benchmark.json. Curated development corpus; labels do not measure independent general accuracy. No database access, imports or Discord messages. Live policy unchanged.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
