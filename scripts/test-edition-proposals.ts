import assert from "node:assert/strict";
import { applyEditionProposal } from "../lib/edition-proposals";
import { enrichReadingsEdition } from "../lib/readings-edition";
import { googleBooksCovers, openLibraryCovers, type CoverCandidate } from "../lib/cover-catalogs";
import type { EditionInput } from "../lib/edition-types";
import { publicEdition } from "../lib/public-edition";

async function main() {
  const candidate: CoverCandidate = { title: "The Odyssey (Readings Classics)", author: "Homer", publisher: "Readings",
    identity: "isbn:9786275100232", source: "https://readings.com.pk/book/1635582", coverUrl: "https://d9z6htgewkjtb.cloudfront.net/9786275100232.webp", catalog: "Readings catalog" };
  const book = { Book_Id: 1635582, BOOK_TITLE: candidate.title, authorName: "Homer", BOOK_ISBN: "9786275100232",
    BOOK_LANGUAGE: "E", binding: "Paperback", PUBLISHED_DATE: "2023-07-10T00:00:00.000Z",
    readings_book_detail: { AuthorDescription: "An Urdu translation by Someone Else is also available." } };
  const signal = AbortSignal.timeout(2000);
  const full = await enrichReadingsEdition(candidate, async url => {
    assert.equal(url, "https://htk3x7p5jf.ap-south-1.awsapprunner.com/api/books/1635582");
    return Buffer.from(JSON.stringify({ book }));
  }, signal);
  assert.equal(full.language, "English"); assert.equal(full.edition, "Paperback · published 2023");
  assert.equal(full.translator, undefined, "marketing descriptions of other translations cannot supply this edition's translator");
  const wrong = await enrichReadingsEdition(candidate, async () => Buffer.from(JSON.stringify({ book: { ...book, BOOK_ISBN: "9780141037455" } })), signal);
  assert.deepEqual(wrong, candidate);
  const offline = await enrichReadingsEdition(candidate, async () => { throw new Error("offline"); }, signal);
  assert.deepEqual(offline, candidate);
  let unexpectedFetch = false;
  await enrichReadingsEdition({ ...candidate, source: "https://example.com/book/1635582" }, async () => { unexpectedFetch = true; return Buffer.from("{}"); }, signal);
  assert.equal(unexpectedFetch, false);
  console.log("PASS exact Readings record supplies language and binding/year; unrelated translator, wrong ISBN, arbitrary hosts and outages cannot contaminate it");

  const value: EditionInput = { publisher: "Old", translator: "Wrong translator", language: "Spanish", edition: "Other edition", evidence: "Old evidence", reviewed: true,
    linkIsbn: "9780141037455", isbnConfirmed: true, isbnEvidence: "Old physical check", candidateId: "", useArtwork: true, expectedRevision: 4, expectedIsbn: "manual-cover-ol1w" };
  const proposal = { ...full, id: "candidate-1", isbn: "9786275100232" };
  const staged = applyEditionProposal(value, proposal);
  assert.equal(staged.publisher, "Readings"); assert.equal(staged.language, "English"); assert.equal(staged.edition, full.edition);
  assert.equal(staged.translator, ""); assert.equal(staged.linkIsbn, proposal.isbn);
  assert.equal(staged.isbnConfirmed, false); assert.equal(staged.isbnEvidence, ""); assert.equal(staged.reviewed, false);
  assert.equal(staged.expectedRevision, 4); assert.equal(staged.expectedIsbn, value.expectedIsbn); assert.equal(staged.useArtwork, true);
  assert.equal(value.translator, "Wrong translator", "staging is immutable and cannot write the book or stock");
  assert.equal(applyEditionProposal({ ...value, expectedIsbn: "9780141037455" }, proposal).linkIsbn, "", "an existing ISBN is not replaced");
  const legacy = applyEditionProposal(value, { ...proposal, language: undefined, edition: undefined });
  assert.equal(legacy.language, ""); assert.equal(legacy.edition, "");
  console.log("PASS catalog application fills available fields and stages ISBN without inheriting prior verification or replacing linked ISBNs");
  const details = { publisher: "Readings", translator: "Unverified manual translator", language: "English", edition: full.edition!, reviewStatus: "unverified", candidates: [proposal] };
  const visible = publicEdition(proposal.isbn, details);
  assert.equal(visible.publisher, "Readings"); assert.equal(visible.language, "English"); assert.equal(visible.edition, full.edition);
  assert.equal(visible.translator, ""); assert.equal(visible.source, proposal.source);
  assert.equal(publicEdition(proposal.isbn, { ...details, candidates: [{ ...proposal, id: "incomplete", publisher: "Other imprint", language: "", edition: "", source: "https://openlibrary.org/books/OL1M" }, proposal] }).source, proposal.source);
  assert.equal(publicEdition("manual-cover-work", details).publisher, "");
  assert.equal(publicEdition("9780141037455", details).publisher, "");
  assert.equal(publicEdition("9780141037455", { ...details, reviewStatus: "reviewed" }).translator, details.translator);
  console.log("PASS exact ISBN-backed catalog fields display with attribution; manual, mismatched and unsupported fields stay hidden until reviewed");

  const meta = { title: "The Odyssey", author: "Homer", isbn: null, coverUrl: null, coverWorkId: "OL1W" };
  const [ol] = await openLibraryCovers(meta, async () => Buffer.from(JSON.stringify({ entries: [{ key: "/books/OL1M", title: "The Odyssey", covers: [1], works: [{ key: "/works/OL1W" }],
    languages: [{ key: "/languages/eng" }], edition_name: "Second edition", contributors: [{ name: "Named translator", role: "Translator" }, { name: "Unrelated editor", role: "Editor" }] }] })), signal);
  assert.equal(ol.language, "English"); assert.equal(ol.edition, "Second edition"); assert.equal(ol.translator, "Named translator");
  const [google] = await googleBooksCovers(meta, async () => Buffer.from(JSON.stringify({ items: [{ id: "volume", volumeInfo: { title: "The Odyssey", authors: ["Homer"], language: "en", publishedDate: "2001-02-03",
    imageLinks: { thumbnail: "https://books.google.com/books/content?id=volume" } } }] })), signal);
  assert.equal(google.language, "English"); assert.equal(google.edition, "Published 2001"); assert.equal(google.translator, undefined);
  console.log("PASS Open Library and Google Books propagate reported metadata; only explicitly credited translators are proposed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
