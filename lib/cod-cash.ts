/** Decimal PKR input to integer paisa, without floating-point rounding or exponent notation. */
export function parseCodCash(value:unknown):number|null {
  if(typeof value!=="string" || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value))return null;
  const [whole,fraction=""]=value.split(".");
  const cents=Number(whole)*100+Number(fraction.padEnd(2,"0"));
  return Number.isSafeInteger(cents)&&cents<=2147483647?cents:null;
}
