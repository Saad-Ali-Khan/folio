CREATE TABLE "discord_commands" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"command" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_commands_message_id_unique" UNIQUE("message_id")
);
