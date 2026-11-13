CREATE TABLE "stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"delta" integer NOT NULL,
	"before_qty" integer NOT NULL,
	"after_qty" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
UPDATE books SET status = 'published' WHERE price_cents > 0;
--> statement-breakpoint
ALTER TABLE books ADD CONSTRAINT valid_book_status CHECK (status IN ('draft', 'published'));
--> statement-breakpoint
ALTER TABLE books ADD CONSTRAINT valid_book_price CHECK (price_cents >= 0 AND (status <> 'published' OR price_cents > 0));
--> statement-breakpoint
ALTER TABLE books ADD CONSTRAINT valid_book_stock CHECK (stock >= 0);
--> statement-breakpoint
INSERT INTO stock_movements(book_id, delta, before_qty, after_qty, reason)
SELECT id, stock, 0, stock, 'opening balance' FROM books;
--> statement-breakpoint
CREATE FUNCTION record_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  INSERT INTO stock_movements(book_id,delta,before_qty,after_qty,reason) VALUES(NEW.id,NEW.stock,0,NEW.stock,'received');
 ELSIF NEW.stock <> OLD.stock THEN
  INSERT INTO stock_movements(book_id,delta,before_qty,after_qty,reason)
  VALUES(NEW.id,NEW.stock-OLD.stock,OLD.stock,NEW.stock,COALESCE(NULLIF(current_setting('folio.stock_reason',true),''),'inventory adjustment'));
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_audit AFTER INSERT OR UPDATE OF stock ON books FOR EACH ROW EXECUTE FUNCTION record_stock_movement();
