-- Manual migration: inspect existing offer rows and take a verified backup first.
-- This migration changes schema only. It aborts when existing rows violate the
-- new rules; review and resolve those rows separately before retrying it.
BEGIN;

DO $$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO invalid_count
    FROM offers
   WHERE (status = 'active' AND (verified_at IS NULL OR valid_until IS NULL))
      OR (valid_from IS NOT NULL AND valid_until IS NOT NULL AND valid_from > valid_until);

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      'MapNifique offer validity migration stopped: % existing offer row(s) need review',
      invalid_count;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'offers'::regclass
       AND conname = 'offers_active_validity_check'
  ) THEN
    ALTER TABLE offers
      ADD CONSTRAINT offers_active_validity_check
      CHECK (status <> 'active' OR (verified_at IS NOT NULL AND valid_until IS NOT NULL))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'offers'::regclass
       AND conname = 'offers_date_range_check'
  ) THEN
    ALTER TABLE offers
      ADD CONSTRAINT offers_date_range_check
      CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE offers VALIDATE CONSTRAINT offers_active_validity_check;
ALTER TABLE offers VALIDATE CONSTRAINT offers_date_range_check;

COMMIT;
