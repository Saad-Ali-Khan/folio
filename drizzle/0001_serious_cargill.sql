CREATE TABLE "sms_commands" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_sid" text NOT NULL,
	"from_number" text NOT NULL,
	"command" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_commands_message_sid_unique" UNIQUE("message_sid")
);
