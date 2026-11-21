-- Corrige le préflight de réconciliation : une identity_key NULL est normale
-- en version 1, avant l'exécution de reconcile-product-identity.js.
-- En version 2, toute identity_key NULL reste une anomalie bloquante.
-- Cette migration ne modifie aucune donnée métier et ne change pas schema_state.
BEGIN;

DO $$
DECLARE v_version INTEGER;
BEGIN
  IF to_regclass('public.schema_state') IS NULL THEN
    RAISE EXCEPTION 'schema_state absent : appliquer les migrations 000 et 001';
  END IF;
  SELECT version INTO v_version FROM public.schema_state WHERE singleton;
  IF v_version NOT IN (1, 2) THEN
    RAISE EXCEPTION 'Migration 003 attend la version 1 ou 2, version actuelle : %', v_version;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION identity_data_problems()
RETURNS SETOF TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v RECORD;
  v_schema_version INTEGER;
BEGIN
  SELECT version INTO v_schema_version FROM schema_state WHERE singleton;
  IF v_schema_version IS NULL THEN
    RETURN NEXT 'schema_state absent';
    RETURN;
  END IF;

  -- En version 1, identity_key NULL est l'état historique attendu avant
  -- réconciliation. Cette absence ne devient une anomalie qu'après le passage
  -- en version 2. Le script de réconciliation calcule et valide chaque clé
  -- avant de l'écrire dans sa transaction finale.
  IF v_schema_version >= 2 THEN
    FOR v IN
      SELECT id FROM products WHERE identity_key IS NULL ORDER BY id LIMIT 200
    LOOP
      RETURN NEXT format('produit %s sans identity_key', v.id);
    END LOOP;
  END IF;

  FOR v IN
    SELECT id, gtin FROM products
     WHERE gtin IS NOT NULL
       AND (
         NOT identity_gtin_valid(gtin)
         OR (v_schema_version >= 2 AND gtin !~ '^[0-9]{14}$')
       )
     ORDER BY id LIMIT 200
  LOOP
    RETURN NEXT format('produit %s avec GTIN invalide ou non canonique : %s', v.id, v.gtin);
  END LOOP;

  FOR v IN
    SELECT id FROM product_candidates
     WHERE status = 'finalized' AND product_id IS NULL
     ORDER BY id LIMIT 200
  LOOP
    RETURN NEXT format('candidat finalisé %s sans produit', v.id);
  END LOOP;

  FOR v IN
    SELECT o.id FROM product_candidate_observations o
     WHERE NOT EXISTS (
       SELECT 1 FROM product_candidate_observation_sources s WHERE s.observation_id = o.id
     )
     ORDER BY o.id LIMIT 200
  LOOP
    RETURN NEXT format('observation de staging %s sans provenance', v.id);
  END LOOP;

  FOR v IN
    SELECT c.id FROM product_candidates c
     WHERE c.status = 'blocked'
       AND NOT EXISTS (
         SELECT 1 FROM product_identity_anomalies a
          WHERE a.candidate_id = c.id OR a.detail->'candidateIds' @> jsonb_build_array(c.id)
       )
     ORDER BY c.id LIMIT 200
  LOOP
    RETURN NEXT format('candidat bloqué %s sans anomalie', v.id);
  END LOOP;

  FOR v IN
    SELECT j.id, COUNT(*) AS pending
      FROM scrape_jobs j
      JOIN product_candidates c ON c.job_id = j.id
     WHERE j.status = 'completed' AND c.status <> 'finalized'
     GROUP BY j.id
  LOOP
    RETURN NEXT format('job %s terminé avec %s candidats non finalisés', v.id, v.pending);
  END LOOP;

  FOR v IN
    SELECT c.id, COUNT(*) AS pending
      FROM product_candidates c
      JOIN scrape_jobs j ON j.id=c.job_id
      JOIN product_candidate_observations o ON o.candidate_id=c.id
     WHERE j.status='completed' AND o.product_observation_id IS NULL
     GROUP BY c.id
     ORDER BY c.id LIMIT 200
  LOOP
    RETURN NEXT format('candidat %s finalisé avec %s observations de staging non consommées', v.id, v.pending);
  END LOOP;

  FOR v IN
    SELECT a.id FROM product_identity_anomalies a
     WHERE a.reviewed_at IS NULL AND a.created_at < NOW() - INTERVAL '400 days'
     ORDER BY a.id LIMIT 50
  LOOP
    RETURN NEXT format('anomalie non revue ancienne : %s', v.id);
  END LOOP;

  FOR v IN
    SELECT source_id, identity_key, array_agg(id ORDER BY id) AS ids
      FROM products
     WHERE identity_key LIKE 'f:%'
     GROUP BY source_id, identity_key
    HAVING COUNT(*) > 1
     ORDER BY source_id, identity_key LIMIT 100
  LOOP
    RETURN NEXT format('collision identité de secours source=%s clé=%s produits=%s', v.source_id, v.identity_key, v.ids);
  END LOOP;

  FOR v IN
    SELECT pi.id FROM product_identifiers pi
     WHERE pi.namespace='gtin'
       AND (pi.value !~ '^[0-9]{14}$' OR NOT identity_gtin_valid(pi.value))
     ORDER BY pi.id LIMIT 100
  LOOP
    RETURN NEXT format('alias GTIN invalide : %s', v.id);
  END LOOP;
END $$;


COMMIT;
