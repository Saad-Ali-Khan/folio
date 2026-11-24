CREATE TABLE "cover_barcode_choices" (
	"id" text PRIMARY KEY NOT NULL,
	"source_message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"cover_ids" jsonb NOT NULL,
	"qty" integer NOT NULL,
	"explicit_qty" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cover_barcode_choices_source_message_id_unique" UNIQUE("source_message_id")
);
--> statement-breakpoint
CREATE TABLE "pending_covers" (
	"id" text PRIMARY KEY NOT NULL,
	"source_message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"object_key" text NOT NULL,
	"qty" integer NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"claim_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"cleaned_at" timestamp with time zone,
	CONSTRAINT "pending_covers_source_message_id_unique" UNIQUE("source_message_id")
);
