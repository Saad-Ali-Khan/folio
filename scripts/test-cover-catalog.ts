import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lookupCoverMetadata } from "../lib/import-metadata";
import { coverTitleVariants } from "../lib/cover-catalog-titles";
import type { CoverLine } from "../lib/cover-ocr";

type Fixture = { id: string; expectedTitle: string; expectedAuthor: string; lines: CoverLine[];
  responses: { query: string; response: unknown }[] };
const normalize = (value: string) => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const reset = () => { (globalThis as typeof globalThis & { folioCoverMatches?: Map<string, unknown> }).folioCoverMatches?.clear(); };
async function main() {
  const originalFetch = globalThis.fetch;
  try {
    const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/catalog-match-regressions.json", import.meta.url), "utf8"));
    for (const fixture of fixtures) {
      reset();
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.pathname === "/authors/OL18404A.json") return Response.json({ name: "Ὅμηρος", alternate_names: ["Homer"] });
        const response = fixture.responses.find(row => row.query === url.searchParams.get("q"));
        assert(response, `No recorded response for ${fixture.id}: ${url}`);
        return Response.json(response.response);
      };
      const match = await lookupCoverMetadata(fixture.lines, true);
      assert(match, fixture.id);
      assert.equal(normalize(match.title), normalize(fixture.expectedTitle), fixture.id);
      assert.equal(normalize(match.author), normalize(fixture.expectedAuthor), fixture.id);
      assert.equal(match.isbn, null);
      assert.equal(match.coverUrl, null);
    }
    const lines = [{ text: "Jane Austen", height: .1 }, { text: "Pride and Prejudice", height: .15 }];
    const doc = { key: "/works/OL1W", title: "Pride and Prejudice", author_name: ["Jane Austen"],
      author_key: ["OL1A"], edition_count: 100, editions: { docs: [{ title: "Pride and Prejudice", language: ["eng"] }] } };
    const lookup = async (docs: unknown[], input = lines) => {
      reset(); globalThis.fetch = async () => Response.json({ docs }); return lookupCoverMetadata(input, true);
    };
    assert.equal(await lookup([{ ...doc, title: "Three Novels (Pride and Prejudice / Emma / Persuasion)" }]), null,
      "a contained novel does not verify a multi-work collection");
    assert.equal(await lookup([{ ...doc, title: "Pride and Prejudice Graphic Novel",
      editions: { docs: [{ title: "Pride and Prejudice", language: ["eng"] }] } }]), null,
      "a simplified edition title cannot hide an unsupported adaptation");
    assert.equal(await lookup([{ ...doc, title: "Pride and Prejudice (The Sequel)",
      editions: { docs: [{ title: "Pride and Prejudice (The Sequel)", language: ["eng"] }] } }]), null);
    assert.equal(await lookup([doc, { ...doc, key: "/works/OL2W" }]), null,
      "equally established records stay ambiguous");
    assert.equal(await lookup([doc], [lines[0], { text: "Pride", height: .15 }]), null,
      "missing distinctive words cannot pass");
    assert.equal(await lookup([{ ...doc, author_name: ["Unrelated Writer"] }]), null);
    assert(!coverTitleVariants("Dune (Messiah)", "Frank Herbert").some(row => row.text === "dune"));
    console.log(`PASS ${fixtures.length} recorded catalog regressions; collection/adaptation/sequel, missing-word/author and ambiguity rejection; ISBN/artwork remain unverified. No network or inventory writes.`);
  } finally { globalThis.fetch = originalFetch; reset(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
