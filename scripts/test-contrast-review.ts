import assert from 'node:assert/strict';
import {adjacentReviewRows,contrastReviewView} from './ocr/contrast-review';
import {supportsTextOnlyReview} from '../lib/cover-suggestions';
import sharp from 'sharp';

async function main(){
 const candidate={title:'The Catcher in the Rye',author:'J. D. Salinger',publisher:'',coverUrl:'',source:'',catalog:'',identity:''};
 const rows=[{text:'the CATCHER',top:.14,height:.09,left:.26,confidence:99},
  {text:'in the RYE',top:.23,height:.09,left:.26,confidence:99},
  {text:'a novel by J. D. SALINGER',top:.79,height:.05,left:.26,confidence:98}];
 assert(!supportsTextOnlyReview(candidate,rows));
 assert(supportsTextOnlyReview(candidate,adjacentReviewRows(rows)));
 for(const altered of [rows.filter((_,i)=>i!==1),rows.map((r,i)=>i===1?{...r,top:.6}:r),
  rows.map((r,i)=>i===1?{...r,left:.7}:r),rows.map((r,i)=>i===1?{...r,confidence:84}:r),
  rows.map((r,i)=>i===1?{...r,text:'INRYE'}:r),rows.map((r,i)=>i===2?{...r,text:'a novel by J. DSALINGER'}:r),
  rows.map((r,i)=>i===2?{...r,text:'a novel by M. A. SALINGER'}:r)]){
  assert(!supportsTextOnlyReview(candidate,adjacentReviewRows(altered)),'missing, distant, misaligned, weak, fused or incompatible text must remain unverified');
 }
 const numbers={...candidate,title:'Fahrenheit 451',author:'Ray Bradbury'};
 const numberRows=[{...rows[0],text:'Fahrenheit'},{...rows[1],text:'451'},{...rows[2],text:'Ray Bradbury'}];
 assert(supportsTextOnlyReview(numbers,adjacentReviewRows(numberRows)));
 assert(!supportsTextOnlyReview(numbers,adjacentReviewRows(numberRows.map((r,i)=>i===1?{...r,text:'452'}:r))));
 assert(!supportsTextOnlyReview({...candidate,title:'The Catcher in the Rye and Other Stories'},adjacentReviewRows(rows)));
 const image=await sharp({create:{width:100,height:80,channels:3,background:'#d07030'}}).png().toBuffer();
 const source=Buffer.from(image);const output=await contrastReviewView(image,true);
 assert.deepEqual(image,source);const info=await sharp(output).metadata();assert.equal(info.width,100);assert.equal(info.height,80);
 console.log('PASS adjacent-row work review; rejects missing/numeric/extra-title, low-confidence, distant/misaligned and fused/incompatible author evidence; contrast preserves original bytes. Isolated geometry checks only.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
