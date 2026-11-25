import type { CoverLine } from "./cover-ocr";

const normalize = (text: string) => text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function mergeCoverReadings(lines: CoverLine[]) {
  const ordered = [...lines].sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
  return ordered.filter((line, index) => !ordered.some((other, otherIndex) => {
    if (index === otherIndex || line.top === undefined || other.top === undefined ||
      Math.abs(line.top - other.top) > 0.025) return false;
    const text = normalize(line.text), alternative = normalize(other.text);
    const compactLength = text.replaceAll(" ", "").length;
    const alternativeLength = alternative.replaceAll(" ", "").length;
    const comparableSpan = Math.min(compactLength, alternativeLength) / Math.max(compactLength, alternativeLength) >= 0.7;
    const overlap = Math.min(line.top + line.height, other.top + other.height) - Math.max(line.top, other.top);
    if (overlap / Math.max(line.height, other.height) >= 0.65 &&
      comparableSpan &&
      (other.confidence ?? 0) >= 85 && (other.confidence ?? 0) - (line.confidence ?? 0) >= 20) return true;
    if (!text.includes(" ") && text.length >= 4 && text.length === alternative.length &&
      [...text].filter((character, i) => character !== alternative[i]).length === 1 &&
      (other.confidence ?? 0) - (line.confidence ?? 0) >= 5) return true;
    if (!text || !alternative.endsWith(text)) return false;
    if (text === alternative) return (other.confidence ?? 0) > (line.confidence ?? 0) ||
      other.confidence === line.confidence && otherIndex < index;
    return !text.includes(" ") && (other.confidence ?? 0) >= 65;
  }));
}

/** Require every distinctive title word, in order; permit only exact joined words.
 * This handles stacked titles and OCR's OFALLTIME without fuzzy title guessing. */
export function stackedTitleProminence(title: string, lines: CoverLine[]) {
  const parts = normalize(title).split(" ");
  const functionWords = new Set(["a", "an", "the", "and", "of", "in", "on", "to", "for", "all"]);
  const required = parts.map((word, index) => ({ word, index })).filter(({ word }) => !functionWords.has(word));
  if (required.length < 2 || required.filter(({ word }) => word.length >= 4).length < 2) return 0;
  const segments = new Map<string, number[]>();
  for (let start = 0; start < parts.length; start++) {
    for (let end = start + 1; end <= parts.length; end++) {
      const indexes = required.filter(({ index }) => index >= start && index < end).map(({ index }) => index);
      if (indexes.length) segments.set(parts.slice(start, end).join(""), indexes);
    }
  }
  let next = 0, prominence = 0;
  for (const line of lines) {
    for (const token of normalize(line.text).split(" ")) {
      const indexes = segments.get(token);
      if (!indexes?.includes(required[next]?.index)) continue;
      while (next < required.length && indexes.includes(required[next].index)) next++;
      prominence = Math.max(prominence, line.height);
      if (next === required.length) return prominence;
    }
  }
  return 0;
}
