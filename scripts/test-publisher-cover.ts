import assert from "node:assert/strict";
import sharp from "sharp";
import { lookupPublisherCover } from "../lib/publisher-cover";

async function main() {
  const originalFetch = globalThis.fetch;
  const cover = await sharp(Buffer.from(`<svg width="300" height="450"><rect width="300" height="450" fill="#eeeecc"/><circle cx="110" cy="100" r="65" fill="#333333"/><rect y="260" width="300" height="190" fill="#1144bb"/><path d="M0 400L300 290L100 450Z" fill="#cc7722"/></svg>`)).png().toBuffer();
  const other = await sharp({ create: { width: 300, height: 450, channels: 3, background: "red" } }).png().toBuffer();
  const record = { Book_Id: 123, BOOK_TITLE: "The Odyssey (Readings Classics)", authorName: "Homer", publisherName: "Readings", BOOK_ISBN: "9786275100232" };
  const meta = { title: "The Odyssey", author: "Homer", isbn: null, coverUrl: null };
  let candidates = [record];
  let catalogImage = cover;
  let offline = false;
  let readingsOffline = false;
  let openEntries: unknown[] = [];
  let googleItems: unknown[] = [];
  const urls: string[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input)); urls.push(url.href);
    if (offline) throw new Error("offline");
    if (url.hostname === "htk3x7p5jf.ap-south-1.awsapprunner.com") {
      if (readingsOffline) throw new Error("Readings offline");
      return Response.json({ results: candidates });
    }
    if (url.hostname === "openlibrary.org") return Response.json({ entries: openEntries });
    if (url.hostname === "www.googleapis.com") return Response.json({ items: googleItems });
    if (["covers.openlibrary.org", "books.google.com"].includes(url.hostname)) return new Response(new Uint8Array(catalogImage));
    assert.equal(url.hostname, "d9z6htgewkjtb.cloudfront.net");
    return new Response(new Uint8Array(catalogImage));
  };
  try {
    const photographed = await sharp(cover).modulate({ brightness: 0.8 }).jpeg({ quality: 70 }).toBuffer();
    const match = await lookupPublisherCover(photographed, meta, ["Readings Classics"]);
    assert.match(match.coverUrl!, /9786275100232\.webp$/);
    assert.equal(match.isbn, null, "matching artwork never assigns a physical ISBN");
    assert.match(match.description!, /Physical ISBN and translator remain unverified/);
    assert.match(match.description!, /https:\/\/readings.com.pk\/book\/123/);
    catalogImage = other;
    assert.equal((await lookupPublisherCover(cover, meta, [])).coverUrl, null, "same title and author with different artwork is rejected");
    catalogImage = cover;
    candidates = [record, { ...record, Book_Id: 456, BOOK_ISBN: "9780141037455" }];
    assert.equal((await lookupPublisherCover(cover, meta, [])).coverUrl, null, "reused covers and near ties require review");
    candidates = [{ ...record, authorName: "Someone Else" }];
    assert.equal((await lookupPublisherCover(cover, meta, [])).coverUrl, null);
    candidates = [{ ...record, publisherName: "Other Publisher" }];
    assert.equal((await lookupPublisherCover(cover, meta, ["Readings"])).coverUrl, null);
    readingsOffline = true;
    openEntries = [{ key: "/books/OL123M", title: "The Odyssey", publishers: ["Penguin Classics"], covers: [123], isbn_13: ["9780141037455"], works: [{ key: "/works/OL991W" }] }];
    const workMeta = { ...meta, coverWorkId: "OL991W" };
    const libraryMatch = await lookupPublisherCover(cover, workMeta, ["Penguin Classics"]);
    assert.match(libraryMatch.coverUrl!, /covers.openlibrary.org/);
    assert.match(libraryMatch.description!, /openlibrary.org\/books\/OL123M/);
    assert.equal(libraryMatch.isbn, null);
    assert.equal((await lookupPublisherCover(cover, { ...workMeta, coverWorkId: "OL992W" }, [])).coverUrl, null, "edition must belong to the identified work");
    const googleVolume = { id: "abc_123", volumeInfo: { title: "The Odyssey", authors: ["Homer"], publisher: "Penguin Classics", imageLinks: { thumbnail: "http://books.google.com/books/content?id=abc_123&img=1" }, industryIdentifiers: [{ identifier: "9780141037455" }] } };
    googleItems = [googleVolume];
    const corroborated = await lookupPublisherCover(cover, workMeta, ["Penguin"]);
    assert(corroborated.coverUrl, "same ISBN found in two sources is not an ambiguous edition");
    openEntries = [];
    const googleMatch = await lookupPublisherCover(cover, meta, ["Penguin"]);
    assert.match(googleMatch.coverUrl!, /^https:\/\/books.google.com\/books\/content/);
    assert.match(googleMatch.description!, /Google Books/);
    assert.equal(googleMatch.isbn, null);
    googleItems = [{ ...googleVolume, volumeInfo: { ...googleVolume.volumeInfo, imageLinks: { thumbnail: "http://127.0.0.1/private" } } }];
    assert.equal((await lookupPublisherCover(cover, meta, [])).coverUrl, null, "catalog cannot supply arbitrary image hosts");
    googleItems = [{ ...googleVolume, volumeInfo: { ...googleVolume.volumeInfo, authors: ["Unrelated Author"] } }];
    assert.equal((await lookupPublisherCover(cover, meta, [])).coverUrl, null, "external catalog author must match");
    offline = true;
    assert.deepEqual(await lookupPublisherCover(cover, meta, []), meta, "network failures preserve identified metadata");
    const before = urls.length;
    await lookupPublisherCover(cover, { ...meta, isbn: "9786275100232" }, []);
    assert.equal(urls.length, before, "ISBN imports bypass heuristic artwork matching");
    console.log("Passed: Readings, Open Library editions, Google Books, source outages, cross-source deduplication, artwork similarity, wrong editions, ambiguity, publisher clues, provenance, ISBN preservation and image host restrictions");
  } finally { globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
