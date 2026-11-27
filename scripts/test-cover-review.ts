import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {findCoverReviewSuggestions,CONTRAST_REVIEW_BUDGET_MS} from '../lib/cover-review';
import {supportsTextOnlyReview} from '../lib/cover-suggestions';
import type {EditionCandidate} from '../lib/edition-types';

async function main(){
 const image=Buffer.from('saved photo');
 const lines=[{text:'a novel by J. D. SALINGER',top:.79,height:.05,left:.26,confidence:98}];
 const green=[{text:'the CATCHER',top:.14,height:.09,left:.26,confidence:99},
  {text:'in the RYE',top:.23,height:.09,left:.26,confidence:99}];
 const proposal:EditionCandidate={id:'a'.repeat(24),title:'The Catcher in the Rye',author:'J. D. Salinger',publisher:'',
  source:'https://openlibrary.org/works/OL123W',catalog:'Open Library work catalog',
  coverUrl:'https://covers.openlibrary.org/b/id/123-L.jpg?default=false',isbn:null,matchQuality:'possible',identityEvidence:'title-author-only'};
 type Deps=NonNullable<Parameters<typeof findCoverReviewSuggestions>[3]>;
 const never=async()=>{throw Error('Unexpected fallback');};
 const first={suggest:async()=>[proposal],health:never,prepare:never,scan:never};
 assert.deepEqual(await findCoverReviewSuggestions(image,lines,true,first),[proposal],'existing suggestions win without health/inference');
 assert.deepEqual(await findCoverReviewSuggestions(image,lines,false,{...first,suggest:async()=>[]}),[],'disabled mobile mode cannot run contrast');
 let searches=0,scans=0;
 const deps:Deps={suggest:async(original,observed,budget)=>{
   assert.equal(original,image,'artwork comparison must use the original uploaded photo');searches++;
   if(searches===1){assert.equal(observed,lines);assert.equal(budget,undefined);return [];}
   assert(budget!>0&&budget!<=CONTRAST_REVIEW_BUDGET_MS);
   assert(supportsTextOnlyReview({...proposal,identity:''},observed));return [proposal];
  },health:async()=>({ready:true,busy:false}),prepare:async()=>Buffer.from('contrast view'),
  scan:async(view,signal)=>{assert.equal(view.toString(),'contrast view');assert(!signal.aborted);scans++;return green;}};
 assert.deepEqual(await findCoverReviewSuggestions(image,lines,true,deps),[proposal]);assert.equal(searches,2);assert.equal(scans,1);
 for(const health of [{ready:false},{ready:true,busy:true}])assert.deepEqual(await findCoverReviewSuggestions(image,lines,true,
  {...deps,suggest:async()=>[],health:async()=>health,scan:never}),[]);
 assert.deepEqual(await findCoverReviewSuggestions(image,lines,true,{...deps,suggest:async()=>[],scan:async()=>{throw Error('Worker unavailable');}}),[]);
 mock.timers.enable({apis:['setTimeout']});
 try{
  let releaseHealth:((value:{ready:boolean})=>void)|undefined;
  const slow=findCoverReviewSuggestions(image,lines,true,{...deps,suggest:async()=>[],health:()=>new Promise(resolve=>{releaseHealth=resolve;}),prepare:never});
  await Promise.resolve();mock.timers.tick(CONTRAST_REVIEW_BUDGET_MS);assert.deepEqual(await slow,[]);
  releaseHealth!({ready:true});await Promise.resolve();await Promise.resolve();
  let finishScan:((value:typeof green)=>void)|undefined,lateSearches=0;
  const late=findCoverReviewSuggestions(image,lines,true,{...deps,suggest:async()=>{lateSearches++;return [];},
   scan:()=>new Promise(resolve=>{finishScan=resolve;})});
  for(let i=0;i<10&&!finishScan;i++)await Promise.resolve();assert(finishScan);
  mock.timers.tick(CONTRAST_REVIEW_BUDGET_MS);assert.deepEqual(await late,[]);
  finishScan(green);for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(lateSearches,1,'a scan completing after the deadline cannot start a catalog lookup');
 }finally{mock.timers.reset();}
 let releaseScan:((value:typeof green)=>void)|undefined,concurrentScans=0;
 const concurrent:Deps={...deps,suggest:async()=>[],scan:async()=>{concurrentScans++;return new Promise(resolve=>{releaseScan=resolve;});}};
 const pending=findCoverReviewSuggestions(image,lines,true,concurrent);
 for(let i=0;i<10&&!releaseScan;i++)await Promise.resolve();assert(releaseScan);
 assert.deepEqual(await findCoverReviewSuggestions(image,lines,true,concurrent),[],'a second fallback cannot queue another scan');
 releaseScan(green);await pending;assert.equal(concurrentScans,1);
 assert.deepEqual(await findCoverReviewSuggestions(image,lines,true,first),[proposal],'later work is available after cancellation/concurrency cleanup');
 console.log('PASS existing-first ordering, disabled/offline/busy skip, one contrast scan, original artwork, bounded remaining budget, timeout/late-result isolation, worker failure and concurrent fallback exclusion. No stock or network.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
