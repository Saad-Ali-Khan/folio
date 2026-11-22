CREATE TABLE "book_editions" (
	"book_id" integer PRIMARY KEY NOT NULL,
	"publisher" text DEFAULT '' NOT NULL,
	"translator" text DEFAULT '' NOT NULL,
	"language" text DEFAULT '' NOT NULL,
	"edition" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"review_status" text DEFAULT 'unverified' NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_editions" ADD CONSTRAINT "book_editions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;