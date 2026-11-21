CREATE TABLE "book_photos" (
	"book_id" integer PRIMARY KEY NOT NULL,
	"data" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_photos" ADD CONSTRAINT "book_photos_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;