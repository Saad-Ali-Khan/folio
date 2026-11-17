CREATE TABLE "cod_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"verification_sid" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "stripe_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_method" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "remitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "remittance_reference" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "remitted_cents" integer;
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "fulfillment_state";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "fulfillment_state" CHECK ("fulfillment_status" IN ('unfulfilled','packed','shipped','delivered','cancelled','returning','returned'));
