import {createHmac, timingSafeEqual} from "node:crypto";

export const ADMIN_COOKIE = "folio-admin";
export const SESSION_SECONDS = 8 * 60 * 60;
function config() {
 if (process.env.NODE_ENV === 'production') {
  const pin = process.env.ADMIN_PIN;
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!pin || pin.length < 16 || pin.length > 128 || pin === process.env.INVENTORY_DISCORD_PIN ||
      !secret || secret.length < 32 || secret === process.env.INVENTORY_DISCORD_SECRET) return {};
  return {pin, secret};
 }
 const pin = process.env.ADMIN_PIN || process.env.INVENTORY_DISCORD_PIN;
 const secret = process.env.ADMIN_SESSION_SECRET || process.env.INVENTORY_DISCORD_SECRET;
 return {pin,secret};
}
function equal(a:string,b:string) {
 const left=Buffer.from(a), right=Buffer.from(b);
 return left.length===right.length && timingSafeEqual(left,right);
}
export function validAdminPin(pin:unknown) {
 const expected=config().pin;
 return !!expected && typeof pin==='string' && equal(pin,expected);
}
export function adminConfigured(){const {pin,secret}=config();return !!pin && !!secret;}
function signature(value:string){const {pin,secret}=config();if(!pin || !secret)throw new Error('Admin access is not configured');return createHmac('sha256',secret).update(`${pin}:${value}`).digest('hex');}
export function issueSession(now=Date.now()) {
 const expires=String(Math.floor(now/1000)+SESSION_SECONDS);
 return `${expires}.${signature(expires)}`;
}
export function validSession(token:string|undefined,now=Date.now()) {
 if(!token || !adminConfigured())return false;
 const [expires,sig,...extra]=token.split('.');
 if(extra.length || !/^\d+$/.test(expires) || !sig || Number(expires)<=now/1000 || Number(expires)>now/1000+SESSION_SECONDS+1)return false;
 return equal(sig,signature(expires));
}
export function appOrigin(request: Request): string | null {
 const configured = process.env.NEXT_PUBLIC_APP_URL;
 try {
  const url = new URL(configured || request.url);
  if (process.env.NODE_ENV === 'production' && (!configured || url.protocol !== 'https:')) return null;
  return url.origin;
 } catch {
  return null;
 }
}
export function sameOrigin(request:Request){
 const origin = process.env.NODE_ENV === 'production' ? appOrigin(request) : new URL(request.url).origin;
 return origin !== null && request.headers.get('origin') === origin;
}
export function requestIsAdmin(request:Request){
 const cookie=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length+1);
 return validSession(cookie);
}
