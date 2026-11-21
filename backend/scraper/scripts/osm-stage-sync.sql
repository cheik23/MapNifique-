BEGIN;

CREATE OR REPLACE FUNCTION public.sync_osm_stage_place_to_catalog()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
    v_region_id TEXT := TG_ARGV[0];
BEGIN
    IF v_region_id IS NULL OR v_region_id = '' THEN
        RAISE EXCEPTION 'Identifiant de région obligatoire.';
    END IF;

    -- Suppression d'un objet OSM dans la région.
    IF TG_OP = 'DELETE' THEN

        DELETE FROM public.osm_place_regions
        WHERE region_id = v_region_id
          AND osm_type = OLD.osm_type
          AND osm_id = OLD.osm_id;

        DELETE FROM public.osm_places p
        WHERE p.osm_type = OLD.osm_type
          AND p.osm_id = OLD.osm_id
          AND NOT EXISTS (
              SELECT 1
              FROM public.osm_place_regions r
              WHERE r.osm_type = p.osm_type
                AND r.osm_id = p.osm_id
          );

        RETURN OLD;
    END IF;

    -- Gestion éventuelle d'un changement d'identifiant.
    IF TG_OP = 'UPDATE'
       AND (OLD.osm_type, OLD.osm_id)
           IS DISTINCT FROM (NEW.osm_type, NEW.osm_id) THEN

        DELETE FROM public.osm_place_regions
        WHERE region_id = v_region_id
          AND osm_type = OLD.osm_type
          AND osm_id = OLD.osm_id;

        DELETE FROM public.osm_places p
        WHERE p.osm_type = OLD.osm_type
          AND p.osm_id = OLD.osm_id
          AND NOT EXISTS (
              SELECT 1
              FROM public.osm_place_regions r
              WHERE r.osm_type = p.osm_type
                AND r.osm_id = p.osm_id
          );
    END IF;

    -- Création ou actualisation de la fiche mondiale.
    INSERT INTO public.osm_places (
        osm_type, osm_id, name, brand,
        category_key, category_value,
        city, postcode, street, house_number, country,
        phone, website, opening_hours,
        osm_version, osm_timestamp, tags,
        geom, location, source_license, source_url,
        last_seen_at, updated_at
    )
    VALUES (
        NEW.osm_type,
        NEW.osm_id,
        NULLIF(BTRIM(NEW.name), ''),
        NULLIF(BTRIM(NEW.brand), ''),
        NEW.category_key,
        NEW.category_value,
        NEW.city,
        NEW.postcode,
        NEW.street,
        NEW.house_number,
        NEW.country,
        NEW.phone,
        NEW.website,
        NEW.opening_hours,
        NEW.osm_version,
        NEW.osm_timestamp,
        COALESCE(NEW.tags, '{}'::jsonb),
        NEW.geom,
        ST_PointOnSurface(NEW.geom)::geography,
        'ODbL',
        'https://www.openstreetmap.org/' ||
            CASE NEW.osm_type
                WHEN 'N' THEN 'node/'
                WHEN 'W' THEN 'way/'
                WHEN 'R' THEN 'relation/'
            END || NEW.osm_id::TEXT,
        NOW(),
        NOW()
    )
    ON CONFLICT (osm_type, osm_id) DO UPDATE SET
        name = EXCLUDED.name,
        brand = EXCLUDED.brand,
        category_key = EXCLUDED.category_key,
        category_value = EXCLUDED.category_value,
        city = EXCLUDED.city,
        postcode = EXCLUDED.postcode,
        street = EXCLUDED.street,
        house_number = EXCLUDED.house_number,
        country = EXCLUDED.country,
        phone = EXCLUDED.phone,
        website = EXCLUDED.website,
        opening_hours = EXCLUDED.opening_hours,
        osm_version = EXCLUDED.osm_version,
        osm_timestamp = EXCLUDED.osm_timestamp,
        tags = EXCLUDED.tags,
        geom = EXCLUDED.geom,
        location = EXCLUDED.location,
        last_seen_at = NOW(),
        updated_at = NOW()
    WHERE COALESCE(EXCLUDED.osm_version, 0)
       >= COALESCE(osm_places.osm_version, 0);

    -- Enregistrement de la présence dans cette région.
    INSERT INTO public.osm_place_regions (
        region_id, osm_type, osm_id
    )
    VALUES (
        v_region_id, NEW.osm_type, NEW.osm_id
    )
    ON CONFLICT (region_id, osm_type, osm_id)
    DO UPDATE SET last_seen_at = NOW();

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS osm_pilot_places_catalog_sync
ON osm_stage.osm_pilot_places;

CREATE TRIGGER osm_pilot_places_catalog_sync
AFTER INSERT OR UPDATE OR DELETE
ON osm_stage.osm_pilot_places
FOR EACH ROW
EXECUTE FUNCTION public.sync_osm_stage_place_to_catalog('fr-idf');

COMMIT;
