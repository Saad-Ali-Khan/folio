CREATE TABLE "order_returns" (
	"reference" text PRIMARY KEY NOT NULL,
	"order_item_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION prevent_reserved_book_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM checkouts c, jsonb_array_elements(c.lines) l WHERE c.status='held' AND (l->>'bookId')::integer=OLD.id) THEN
  RAISE EXCEPTION 'Book has an active checkout reservation';
 END IF;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER protect_reserved_book BEFORE DELETE ON books FOR EACH ROW EXECUTE FUNCTION prevent_reserved_book_delete();
