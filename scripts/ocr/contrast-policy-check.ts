import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {suggestCoverCandidates} from '../../lib/cover-suggestions';
const read=(name:string)=>JSON.parse(readFileSync(`.folio-ocr/${name}.json`,'utf8'));
const norm=(s:string)=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
async function main(){
 const manifest=readFileSync('.folio-ocr/cases.json'),samples=JSON.parse(manifest.toString());
 const experiment=read('contrast-benchmark');
 if(!experiment.complete||experiment.datasetHash!==createHash('sha256').update(manifest).digest('hex'))throw Error('Experiment incomplete/stale');
 const sources=['paddle','tesseract','paddle-geometry'].map(read),rows=[];
 for(const trial of experiment.rows){
  if(String(trial.catalog).startsWith('earlier automatic'))continue;
  const sample=samples.find((s:{id:string})=>s.id===trial.sample);
  const lines=sources.flatMap(source=>source.cases.find((c:{id:string})=>c.id===trial.sample)?.lines??[]);
  const baseline=await suggestCoverCandidates(readFileSync(`.folio-ocr/${sample.image}`),lines);
  const proposals=baseline.length?baseline:trial.proposals;
  const correct=proposals.every((p:{title:string;author:string})=>[sample.expectedTitle,...sample.expectedTitleAliases??[]].some((t:string)=>norm(t)===norm(p.title.replace(/\s*\([^)]*\)\s*$/,'')))&&
   [sample.expectedAuthor,...sample.expectedAuthorAliases??[]].some((a:string)=>norm(a)===norm(p.author)));
  const row={sample:trial.sample,baseline,experimental:trial.proposals,selectedStage:baseline.length?'existing review':proposals.length?'contrast review':'unresolved',correct:proposals.length?correct:null};
  rows.push(row);console.log(trial.sample,`baseline=${baseline.length}`,row.selectedStage,row.correct);
  writeFileSync('.folio-ocr/contrast-policy-check.json',JSON.stringify({complete:false,rows},null,2));
 }
 const summary={previousAutomaticPaths:19,automaticPathsRemeasured:false,existingReview:rows.filter(r=>r.selectedStage==='existing review').length,
  newReview:rows.filter(r=>r.selectedStage==='contrast review').length,unresolved:rows.filter(r=>r.selectedStage==='unresolved').length,mismatches:rows.filter(r=>r.correct===false).length};
 writeFileSync('.folio-ocr/contrast-policy-check.json',JSON.stringify({complete:true,summary,rows},null,2));console.log(JSON.stringify(summary));
 console.log('Read-only catalog comparison, same saved images/OCR. Baseline and experimental catalog calls occur at different times; not a frozen-response benchmark. No live policy change.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
