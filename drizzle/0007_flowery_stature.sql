CREATE TABLE "title_choices" (
	"id" text PRIMARY KEY NOT NULL,
	"source_message_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"qty" integer NOT NULL,
	"book_id" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "title_choices_source_message_id_unique" UNIQUE("source_message_id")
);
