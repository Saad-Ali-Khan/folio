// Used only for review after ordinary recognition and existing suggestions fail.
import sharp from 'sharp';
import type {LocatedLine} from './cover-geometry';

export async function contrastReviewView(image:Buffer,green=false){
  let view=sharp(image,{limitInputPixels:40_000_000}).rotate().flatten({background:'white'})
    .resize({width:1100,height:1400,fit:'inside',withoutEnlargement:true});
  if(green)view=view.extractChannel('green').normalise();
  return view.png().toBuffer();
}

/** Compose at most three adjacent, similarly sized, aligned high-confidence rows.
 * Observed words stay unchanged. No labels, spelling repair or initials expansion. */
export function adjacentReviewRows(lines:LocatedLine[]):LocatedLine[]{
  const strong=lines.filter(row=>(row.confidence??0)>=85&&row.top!==undefined&&row.height>=.025&&row.height<=.35&&
    row.text.trim().length<=120&&row.text.trim().split(/\s+/).length<=8).slice(0,80);
  const joined:LocatedLine[]=[];
  const adjacent=(a:LocatedLine,b:LocatedLine)=>b.top!>a.top!&&
    b.top!-a.top!>=a.height*.5&&b.top!-a.top!<=Math.max(a.height,b.height)*1.5&&
    Math.min(a.height,b.height)>=Math.max(a.height,b.height)*.5&&
    a.left!==undefined&&b.left!==undefined&&Math.abs(a.left-b.left)<=.08;
  const add=(rows:LocatedLine[])=>{
    const text=rows.map(row=>row.text.trim()).join(' ');
    if(text.length>200||joined.some(row=>row.text===text)||joined.length>=48)return;
    joined.push({...rows[0],text,height:Math.max(...rows.map(row=>row.height)),confidence:Math.min(...rows.map(row=>row.confidence??0))});
  };
  for(const first of strong)for(const second of strong){
    if(!adjacent(first,second))continue;
    add([first,second]);
    for(const third of strong)if(adjacent(second,third))add([first,second,third]);
  }
  return [...lines,...joined];
}
