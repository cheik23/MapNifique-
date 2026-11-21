-- Manual migration: inspect existing rows and take a verified backup first.
-- It refuses to guess identifiers for historical offers with missing IDs.
BEGIN;

DO $$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_count
    FROM offers
   WHERE external_id IS NULL OR length(btrim(external_id)) NOT BETWEEN 1 AND 160;

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'MapNifique offer identifier migration stopped: % existing offer row(s) need review',
      invalid_count;
  END IF;
END $$;

ALTER TABLE offers
  ALTER COLUMN external_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'offers'::regclass
       AND conname = 'offers_external_id_nonempty_check'
  ) THEN
    ALTER TABLE offers
      ADD CONSTRAINT offers_external_id_nonempty_check
      CHECK (length(btrim(external_id)) BETWEEN 1 AND 160)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE offers VALIDATE CONSTRAINT offers_external_id_nonempty_check;

COMMIT;
