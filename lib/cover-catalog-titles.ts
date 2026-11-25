export const normalizeCoverTitle = (value: string) => value.normalize("NFKD").toLowerCase()
  .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const collection = /\b(?:novels|boxed set|box set|omnibus|complete works|complete novels|three books|three novels|trilogy)\b/i;
const adaptation = /\b(?:classics illustrated|graphic novel|retold|abridged|adapted|study guide|teacher guide|summary|sparknotes|cliffsnotes)\b/i;
const format = /\b(?:audio(?:book)?|narrat(?:ed|or)|audio cd|classics illustrated|graphic novel|retold|abridged|adapted|study guide|teacher guide|summary|sparknotes|cliffsnotes)\b/i;

export function isCoverCollection(value: string) { return collection.test(value) || /\s\/\s/.test(value); }
export function hasCoverAdaptation(value: string) { return adaptation.test(value); }
export function hasCoverFormatLabel(value: string) { return format.test(value); }

/** Strip a verified author attribution, never an arbitrary subtitle/sequel. */
export function coverTitleVariants(value: string, author: string, bilingual = false) {
  const name = normalizeCoverTitle(author);
  const raw = [value.trim()];
  if (bilingual) raw.push(...value.split(/\s+\/\s+/).map(value => value.trim()));
  // Remove only known format labels, never an arbitrary subtitle or sequel.
  const parenthetical = value.match(/^([^()]+)\s*\(([^()]*)\)\s*$/);
  if (parenthetical && hasCoverFormatLabel(parenthetical[2])) raw.push(parenthetical[1].trim());
  if (parenthetical && [name + " collection", "the " + name + " collection"]
    .includes(normalizeCoverTitle(parenthetical[1]))) raw.push(parenthetical[2].trim());
  const variants: { text: string; display: string }[] = [];
  for (const display of raw) {
    const text = normalizeCoverTitle(display);
    if (text) variants.push({ text, display });
    // Preserve the spelling/case of the actual title substring.
    const tokens = [...display.matchAll(/[\p{L}\p{N}]+/gu)];
    for (let cut = 1; cut < tokens.length; cut++) {
      const left = normalizeCoverTitle(display.slice(0, tokens[cut].index));
      const right = normalizeCoverTitle(display.slice(tokens[cut].index));
      if (left === name || left === `${name} s`) {
        const title = display.slice(tokens[cut].index).trim();
        variants.push({ text: normalizeCoverTitle(title), display: title });
      }
      if (right === name && /\b(?:by|of)\s*$/i.test(display.slice(0, tokens[cut].index).trim())) {
        const title = display.slice(0, tokens[cut].index).replace(/\s+(?:by|of)\s*$/i, "").trim();
        variants.push({ text: normalizeCoverTitle(title), display: title });
      }
    }
  }
  const authorParts = new Set(name.split(" "));
  return variants.filter((variant, i) => variant.text &&
    !variant.text.split(" ").every(word => authorParts.has(word)) &&
    variants.findIndex(other => other.text === variant.text) === i);
}

export function compatibleCoverAuthor(best: string, alternative: string) {
  const a = normalizeCoverTitle(best).split(" ").filter(part => part.length > 1);
  const b = normalizeCoverTitle(alternative).split(" ").filter(part => part.length > 1);
  return a.length > b.length && b.length > 0 && b.every(part => a.includes(part));
}
