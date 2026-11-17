CREATE TABLE "cod_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"delivery" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"order_id" integer
);
--> statement-breakpoint
ALTER TABLE "cod_requests" ADD CONSTRAINT "cod_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP TABLE "cod_verifications";
