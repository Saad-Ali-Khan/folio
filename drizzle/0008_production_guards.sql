CREATE TABLE "discord_stock_choices" (
	"id" text PRIMARY KEY NOT NULL,
	"source_message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"book_ids" jsonb NOT NULL,
	"verb" text NOT NULL,
	"qty" integer,
	"resolved" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "discord_stock_choices_source_message_id_unique" UNIQUE("source_message_id")
);
--> statement-breakpoint
CREATE TABLE "request_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkouts" ADD COLUMN "client_key" text;