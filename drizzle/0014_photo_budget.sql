CREATE TABLE "photo_objects" (
	"key" text PRIMARY KEY NOT NULL,
	"bytes" integer NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_upload_months" (
	"month" text PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
