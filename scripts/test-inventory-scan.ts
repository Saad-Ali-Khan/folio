import assert from 'node:assert/strict';
import sharp from 'sharp';
import bwip from 'bwip-js/node';
import {decodeBarcode, normalizeIsbn} from '../lib/inventory-scan';
async function main(){
 const barcode=await bwip.toBuffer({bcid:'ean13',text:'9780141037455',scale:2,height:15,paddingwidth:15,paddingheight:10});
 for(const angle of [0,90,180,270,5]){
 const image=await sharp(barcode).rotate(angle,{background:'white'}).png().toBuffer();
 assert.equal(await decodeBarcode(image),'9780141037455',`rotation ${angle}`);
 }
 const transparent=await sharp(barcode).ensureAlpha().png().toBuffer();
 assert.equal(await decodeBarcode(transparent),'9780141037455');
 const small=await sharp(barcode).resize({width:180}).png().toBuffer();
 const canvas=await sharp({create:{width:800,height:1000,channels:3,background:'#333333'}}).composite([{input:small,left:70,top:80}]).png().toBuffer();
 assert.equal(await decodeBarcode(canvas),'9780141037455','small off-center barcode');
 const blank=await sharp({create:{width:400,height:500,channels:3,background:'white'}}).png().toBuffer();
 assert.equal(await decodeBarcode(blank),null);
 assert.equal(normalizeIsbn('9780141037456'),null);
 assert.equal(normalizeIsbn('0141037458'),'9780141037455');
 assert.equal(normalizeIsbn('0141037459'),null);
 console.log('Passed barcode regression checks');
}
main().catch(e=>{console.error(e);process.exitCode=1});
