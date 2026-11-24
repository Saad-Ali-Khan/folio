ALTER TABLE "book_photos" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "photo_upload_months" ADD COLUMN "reads" integer DEFAULT 0 NOT NULL;