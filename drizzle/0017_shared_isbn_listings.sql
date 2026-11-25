ALTER TABLE "books" DROP CONSTRAINT "books_isbn_unique";--> statement-breakpoint
DROP INDEX "books_canonical_isbn_unique";--> statement-breakpoint
CREATE INDEX "books_canonical_isbn_idx" ON "books" USING btree (folio_isbn_key("isbn"));--> statement-breakpoint
CREATE UNIQUE INDEX "books_unverified_key_unique" ON "books" USING btree ("isbn") WHERE folio_isbn_key("books"."isbn") IS NULL;