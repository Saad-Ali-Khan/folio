import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readCoverLines, type CoverLine } from "../lib/cover-ocr";
import { mergeCoverReadings, stackedTitleProminence } from "../lib/cover-title";
import { CatalogUnavailable, lookupCoverMetadata } from "../lib/import-metadata";

const title = "The Greatest Minds and Ideas of All Time";
const line = (text: string, top: number, height = 0.1, confidence = 95): CoverLine => ({ text, top, height, confidence });
// Representative output from the reported large-serif, stacked-title cover.
const fixture = [line("WILL", 0.04), line("DU", 0.16), line("DURANT", 0.16),
  line("WINNER OF THE PULITZER PRIZE AND THE MEDAL OF FREEDOM", 0.28, 0.02),
  line("GREATEST", 0.39), line("REATEST", 0.39, 0.1, 89),
  line("MINDS", 0.51), line("AINDS", 0.51, 0.1, 89), line("NED S", 0.53, 0.1, 67),
  line("DEAS", 0.67, 0.1, 87), line("IDEAS", 0.67, 0.1, 69),
  line("ALLTIME", 0.83), line("COMPILED AND EDITED BY JOHN LITTLE", 0.93, 0.02)];

async function main() {
  const merged = mergeCoverReadings(fixture);
  assert(!merged.some(line => ["REATEST", "DEAS", "NED S", "AINDS"].includes(line.text)));
  assert(stackedTitleProminence(title, merged) > 0);
  assert.equal(stackedTitleProminence(title, merged.filter(line => line.text !== "IDEAS")), 0);
  assert.equal(stackedTitleProminence("The Greatest Minds of Another Time", merged), 0);
  assert.equal(stackedTitleProminence("Ideas Minds Greatest Time", merged), 0);
  assert.equal(stackedTitleProminence("Great Minds", merged), 0, "short titles need exact phrases");
  assert(mergeCoverReadings([line("The Little Prince", 0.1, 0.06, 74), line("he", 0.1, 0.06, 96)])
    .some(line => line.text === "The Little Prince"), "a strong fragment cannot erase a complete line");
  let readings = fixture;
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/stacked-cover-readings.json", import.meta.url), "utf8")) as {
    initial: CoverLine[]; focused: CoverLine[];
  };
  assert(stackedTitleProminence(title, mergeCoverReadings([...recorded.initial, ...recorded.focused])) > 0,
    "actual Discord reading order and mixed-size lettering remain recognizable");
  const imagePath = process.argv[2];
  if (imagePath) {
    const image = readFileSync(imagePath);
    readings = [...await readCoverLines(image), ...await readCoverLines(image, true)];
    const cleaned = mergeCoverReadings(readings);
    assert(stackedTitleProminence(title, cleaned) > 0, "real photo must supply all distinctive title words");
    assert(cleaned.some(line => /durant/i.test(line.text)), "real photo must supply the author");
    console.log("PASS supplied photo: large-serif author and stacked title read without a barcode");
  }
  const originalFetch = globalThis.fetch;
  try {
    let queries = "";
    const doc = { key: "/works/OL1073943W", title, author_name: ["Will Durant", "John Little"],
      editions: { docs: [{ title, language: ["eng"] }] } };
    globalThis.fetch = async input => {
      queries += new URL(String(input)).searchParams.get("q") ?? "";
      return Response.json({ docs: queries.includes('"minds" AND "ideas"') ? [doc] : [] });
    };
    const result = await lookupCoverMetadata(readings, true);
    assert.equal(result?.title, title);
    assert.equal(result?.author, "Will Durant");
    assert.equal(result?.isbn, null, "a front cover cannot establish an ISBN");
    assert.equal(result?.coverUrl, null, "do not borrow another edition's artwork");
    assert.equal((await lookupCoverMetadata([...recorded.initial, ...recorded.focused], true))?.coverWorkId, "OL1073943W");
    assert.equal(await lookupCoverMetadata(readings.filter(line => !/will|durant/i.test(line.text))), null);
    globalThis.fetch = async () => Response.json({ docs: [{ ...doc, author_name: ["Unrelated Writer"] }] });
    assert.equal(await lookupCoverMetadata([...readings, line("different scan", 0.99)]), null);
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(lookupCoverMetadata([...readings, line("offline scan", 0.99)]), CatalogUnavailable);
    const authorPrefix = JSON.parse(readFileSync(new URL("./fixtures/catalog-author-prefix.json", import.meta.url), "utf8"));
    globalThis.fetch = async () => Response.json({ docs: [authorPrefix.misleadingDoc] });
    assert.equal(await lookupCoverMetadata(authorPrefix.lines, true), null,
      "the visible author alone must not match another book through a catalog-title prefix");
    globalThis.fetch = async () => Response.json({ docs: [authorPrefix.misleadingDoc, authorPrefix.correctDoc, authorPrefix.englishDoc] });
    assert.match((await lookupCoverMetadata(authorPrefix.lines, true))?.title ?? "", /^the little prince$/i,
      "recorded Little Prince OCR selects the correct work and rejects Letters to Mother");
    console.log("PASS stacked title, search query, missing-word/order/author rejection, and catalog outage checks; no database writes");
  } finally { globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
