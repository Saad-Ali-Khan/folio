CREATE TABLE "checkouts" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"stripe_session_id" text,
	"lines" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkouts_stripe_session_id_unique" UNIQUE("stripe_session_id")
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "returned_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "currency" text DEFAULT 'pkr' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subtotal_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_address" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_status" text DEFAULT 'unfulfilled' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_id_unique" UNIQUE("checkout_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_intent_id_unique" UNIQUE("payment_intent_id");
--> statement-breakpoint
-- Existing prices were entered as USD amounts. Preserve values for review,
-- but require deliberate PKR repricing and republication.
UPDATE books SET status='draft';
--> statement-breakpoint
UPDATE orders SET currency='usd';
--> statement-breakpoint
ALTER TABLE checkouts ADD CONSTRAINT checkout_state CHECK(status IN ('held','paid','released'));
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT fulfillment_state CHECK(fulfillment_status IN ('unfulfilled','packed','shipped','delivered','cancelled'));
--> statement-breakpoint
ALTER TABLE order_items ADD CONSTRAINT valid_return CHECK(returned_qty >= 0 AND returned_qty <= qty);
