CREATE TABLE "telegram_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"update_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"command" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_updates_update_id_unique" UNIQUE("update_id")
);
