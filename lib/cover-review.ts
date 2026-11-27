import type {CoverLine} from './cover-ocr';
import type {LocatedLine} from './cover-geometry';
import type {EditionCandidate} from './edition-types';
import {suggestCoverCandidates} from './cover-suggestions';
import {contrastReviewView,adjacentReviewRows} from './contrast-review';
import {callLocalOcr,localOcrHealth} from './local-ocr-client';

export const CONTRAST_REVIEW_BUDGET_MS=6000;
type Dependencies={
  suggest(image:Buffer,lines:CoverLine[],budgetMs?:number):Promise<EditionCandidate[]>;
  health():Promise<{ready:boolean;busy?:boolean}>;
  prepare(image:Buffer):Promise<Buffer>;
  scan(image:Buffer,signal:AbortSignal):Promise<LocatedLine[]>;
};
const defaults:Dependencies={
  suggest:(image,lines,budgetMs)=>suggestCoverCandidates(image,lines,undefined,budgetMs),
  health:localOcrHealth,prepare:image=>contrastReviewView(image,true),
  scan:async(image,signal)=>(await callLocalOcr(image,'detect',signal)).lines!,
};
let contrastBusy=false;

/** Review only: existing proposals always win. This function never receives stock. */
export async function findCoverReviewSuggestions(image:Buffer,lines:CoverLine[],mobileEnabled:boolean,
  deps:Dependencies=defaults):Promise<EditionCandidate[]>{
  const existing=await deps.suggest(image,lines);
  if(existing.length||!mobileEnabled||contrastBusy)return existing;
  contrastBusy=true;
  const controller=new AbortController(),deadline=Date.now()+CONTRAST_REVIEW_BUDGET_MS;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const work=(async()=>{
    const health=await deps.health();controller.signal.throwIfAborted();
    if(!health.ready||health.busy)return [];
    const view=await deps.prepare(image);controller.signal.throwIfAborted();
    const extra=await deps.scan(view,controller.signal);controller.signal.throwIfAborted();
    const remaining=deadline-Date.now();if(remaining<100)return [];
    const proposals=await deps.suggest(image,adjacentReviewRows([...lines,...extra]),remaining);
    controller.signal.throwIfAborted();return proposals;
  })();
  try{
    return await Promise.race([work,new Promise<EditionCandidate[]>(resolve=>{
      timer=setTimeout(()=>{controller.abort();resolve([]);},CONTRAST_REVIEW_BUDGET_MS);
    })]);
  }catch{return [];}
  finally{clearTimeout(timer);controller.abort();contrastBusy=false;}
}
