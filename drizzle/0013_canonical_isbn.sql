-- ISBN aliases must collide even when one source uses ISBN-10 or hyphenated text.
-- Invalid/legacy work keys return NULL and retain the existing raw-key constraint.
CREATE FUNCTION folio_isbn_key(value text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE digits text := regexp_replace(upper(value), '[[:space:]-]', '', 'g');
total integer := 0;
i integer;
digit integer;
BEGIN
  IF digits ~ '^[0-9]{9}[0-9X]$' THEN
    FOR i IN 1..10 LOOP
      digit := CASE WHEN substr(digits, i, 1) = 'X' THEN 10 ELSE substr(digits, i, 1)::integer END;
      total := total + digit * (11-i);
    END LOOP;
    IF total % 11 <> 0 THEN RETURN NULL; END IF;
    digits := '978' || substr(digits, 1, 9);
    total := 0;
    FOR i IN 1..12 LOOP
      total := total + substr(digits, i, 1)::integer * CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END;
    END LOOP;
    RETURN digits || ((10 - total % 10) % 10)::text;
  END IF;
  IF digits !~ '^97[89][0-9]{10}$' THEN RETURN NULL; END IF;
  FOR i IN 1..13 LOOP
    total := total + substr(digits, i, 1)::integer * CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END;
  END LOOP;
  IF total % 10 <> 0 THEN RETURN NULL; END IF;
  RETURN digits;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "books_canonical_isbn_unique" ON "books" USING btree (folio_isbn_key("isbn"));
