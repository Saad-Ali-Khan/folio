import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { Database } from "../lib/db";
import * as schema from "../lib/db/schema";
import { applyMigrations } from "../lib/db/migrations";
import { canonicalIsbn } from "../lib/isbn";
import { getEdition, storeEditionCandidates } from "../lib/book-editions";
import type { EditionInput, EditionCandidate } from "../lib/edition-types";
import { deleteAdminBook, updateAdminBook } from "../lib/admin-books";
import { importDiscordBook } from "../lib/discord-inventory";
import { GET as readEdition } from "../app/api/admin/books/edition/route";
import { POST as refreshCandidates } from "../app/api/admin/books/edition/candidates/route";
import { queueTitleChoice, resolveTitleChoice } from "../lib/title-choice";

async function main() {
  const engine = new PGlite();
  try {
    const db = drizzle(engine, { schema }) as unknown as Database;
    const migrations = readdirSync("drizzle").filter(name => name.endsWith(".sql")).sort().map(name => ({ name, contents: readFileSync(`drizzle/${name}`, "utf8") }));
    await applyMigrations(db, migrations);
    for (const isbn of ["9780141037455", "0-14-103745-8", "0-8044-2957-X", "9780306406157", "9791234567896", "9780141037456", "not-an-isbn", "manual-cover-ol1w", ""] ) {
      const result = await engine.query<{ key: string | null }>("select folio_isbn_key($1) as key", [isbn]);
      assert.equal(result.rows[0].key, canonicalIsbn(isbn), `SQL/JS ISBN equivalence: ${isbn}`);
    }
    assert.equal(canonicalIsbn("0-14-103745-8"), "9780141037455");
    assert.equal(canonicalIsbn("9780141037456"), null);
    console.log("PASS checksum validation, ISBN-10 conversion and database canonical key agree");

    const [book] = await db.insert(schema.books).values({ isbn: "manual-cover-oltestw", slug: "edition-test", title: "The Odyssey", author: "Homer", priceCents: 80000, stock: 2, status: "draft" }).returning();
    const edition: EditionInput = { publisher: "Readings", translator: "", language: "", edition: "", evidence: "Publisher printed on uploaded cover; translator not established.", reviewed: false,
      linkIsbn: "", isbnConfirmed: false, isbnEvidence: "", candidateId: "", useArtwork: false, expectedRevision: 0, expectedIsbn: book.isbn };
    const candidate: EditionCandidate = { id: "catalog-1", title: book.title, author: book.author, publisher: "Readings", isbn: "9780141037455",
      source: "https://readings.com.pk/book/1", coverUrl: "https://d9z6htgewkjtb.cloudfront.net/9780141037455.webp", catalog: "Readings catalog" };
    const input = (row: typeof book, details: EditionInput) => ({ ...row, price: String(row.priceCents / 100), expected: row, editionDetails: details });
    const beforeMovements = (await db.select().from(schema.stockMovements)).length;
    await db.transaction(tx => storeEditionCandidates(tx as unknown as Database, book.id, [candidate]));
    const proposed = await getEdition(db, book.id);
    assert.equal(proposed.publisher, ""); assert.equal(proposed.translator, ""); assert.equal(proposed.reviewed, false);
    assert.equal((await db.select().from(schema.books).where(eq(schema.books.id, book.id)))[0].isbn, book.isbn);
    await assert.rejects(updateAdminBook(db, input(book, edition)), /Edition details changed/);
    const reviewedInput = { ...edition, expectedRevision: proposed.revision };
    const saved = await updateAdminBook(db, input(book, reviewedInput));
    assert.equal(saved.stock, 2); assert.equal(saved.slug, book.slug);
    assert.equal((await getEdition(db, book.id)).translator, "");
    assert.equal((await db.select().from(schema.stockMovements)).length, beforeMovements);
    console.log("PASS proposals remain unverified, stale edits rejected, edition-only save leaves stock and audit unchanged");

    const fresh = await getEdition(db, book.id);
    await assert.rejects(updateAdminBook(db, input(saved, { ...reviewedInput, expectedRevision: fresh.revision, reviewed: true, evidence: "" })), /source or physical page/);
    await assert.rejects(updateAdminBook(db, input(saved, { ...reviewedInput, expectedRevision: fresh.revision, linkIsbn: "9780141037455" })), /physical copy/);
    const evidenced = await updateAdminBook(db, input(saved, { ...reviewedInput, expectedRevision: fresh.revision,
      reviewed: true, translator: "Example translator", language: "English", edition: "Test edition", evidence: "Synthetic copyright-page verification", candidateId: candidate.id, useArtwork: true }));
    assert.equal(evidenced.coverUrl, candidate.coverUrl);
    assert.equal(evidenced.isbn, book.isbn, "accepting a cover must not assign the candidate ISBN");
    assert.equal((await getEdition(db, book.id)).reviewed, true);
    const reviewedRevision = (await getEdition(db, book.id)).revision;
    await db.transaction(tx => storeEditionCandidates(tx as unknown as Database, book.id, [{ ...candidate, publisher: "Updated catalog proposal" }]));
    const retained = await getEdition(db, book.id);
    assert.equal(retained.publisher, "Readings"); assert.equal(retained.reviewed, true);
    assert.equal(retained.candidates[0].publisher, "Updated catalog proposal");
    assert.ok(retained.revision > reviewedRevision);
    console.log("PASS evidence required, explicit artwork choice preserves ISBN, refreshed proposals preserve reviewed metadata");

    const linked = await updateAdminBook(db, input(evidenced, { ...reviewedInput, expectedRevision: retained.revision,
      linkIsbn: "0-14-103745-8", isbnConfirmed: true, isbnEvidence: "", candidateId: candidate.id }));
    assert.equal(linked.isbn, "9780141037455"); assert.equal(linked.id, book.id); assert.equal(linked.slug, book.slug); assert.equal(linked.stock, 2);
    assert.match((await getEdition(db, book.id)).evidence, /Physical ISBN 9780141037455/);
    assert.match((await getEdition(db, book.id)).evidence, /admin confirmed against the physical copy/);
    assert.match((await getEdition(db, book.id)).evidence, /Catalog reference: Readings catalog, https:\/\/readings.com.pk\/book\/1/);
    const [other] = await db.insert(schema.books).values({ isbn: "manual-other-copy", slug: "other-copy", title: "Other title", author: "Other author", priceCents: 10000, stock: 3 }).returning();
    const beforeSharedMovements = (await db.select().from(schema.stockMovements)).length;
    const second = await updateAdminBook(db, input(other, { ...edition, expectedIsbn: other.isbn,
      linkIsbn: "9780141037455", isbnConfirmed: true, isbnEvidence: "Test physical scan" }));
    assert.equal(second.isbn, linked.isbn); assert.equal(second.stock, 3); assert.equal(second.title, other.title);
    assert.equal((await db.select().from(schema.books).where(eq(schema.books.id, linked.id)))[0].stock, 2);
    assert.equal((await db.select().from(schema.stockMovements)).length, beforeSharedMovements);
    await db.insert(schema.books).values({ isbn: "0141037458", slug: "duplicate-alias", title: "Duplicate", author: "Test", priceCents: 0 });
    await assert.rejects(importDiscordBook(db, "alias-import", "test-channel", { title: linked.title, author: linked.author, isbn: "0141037458", coverUrl: null }, 1), /Multiple listings/);
    assert.equal((await db.select().from(schema.books)).length, 3);
    assert.equal((await db.select().from(schema.books).where(eq(schema.books.id, linked.id)))[0].stock, 2);
    console.log("PASS shared physical ISBN linking preserves separate IDs, slugs and stock; alias matches require listing selection");

    await queueTitleChoice(db, "cover-choice", "test-channel", "operator", { title: "Example translation", author: "Example author", isbn: null,
      coverUrl: null, coverWorkId: "OL123W", editionCandidates: [candidate], titleOptions: { english: "Example translation", original: "Original title" } }, 1);
    const [choice] = await db.select().from(schema.titleChoices).where(eq(schema.titleChoices.sourceMessageId, "cover-choice"));
    await resolveTitleChoice(db, choice.id, "test-channel", "operator", "ENGLISH");
    const [choiceBook] = await db.select().from(schema.books).where(eq(schema.books.isbn, "manual-cover-ol123w"));
    assert.equal((await getEdition(db, choiceBook.id)).candidates[0].id, candidate.id);
    assert.equal((await getEdition(db, choiceBook.id)).reviewed, false);
    await resolveTitleChoice(db, choice.id, "test-channel", "operator", "ENGLISH");
    assert.equal((await db.select().from(schema.books).where(eq(schema.books.id, choiceBook.id)))[0].stock, 1);
    console.log("PASS catalog proposals survive deferred Discord title choices without assigning ISBN or duplicating stock");

    await assert.rejects(deleteAdminBook(db, { expected: linked }), /Edition details changed/);
    const [latest] = await db.select().from(schema.books).where(eq(schema.books.id, book.id));
    await deleteAdminBook(db, { expected: latest, expectedEditionRevision: (await getEdition(db, book.id)).revision });
    assert.equal((await db.select().from(schema.bookEditions).where(eq(schema.bookEditions.bookId, book.id))).length, 0);
    assert.equal((await readEdition(new Request("http://localhost/api/admin/books/edition?bookId=1"))).status, 401);
    assert.equal((await refreshCandidates(new Request("http://localhost/api/admin/books/edition/candidates", { method: "POST", headers: { origin: "https://other.invalid" } }))).status, 403);
    console.log("PASS stale edition deletion rejected, confirmed deletion cascades, admin read/write authorization enforced");
  } finally { await engine.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
