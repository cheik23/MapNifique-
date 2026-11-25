const safeLog = (logger, level, ...args) => {
  if (typeof logger?.[level] === 'function') logger[level](...args);
};

export async function upsertOffer(db, offer) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query requis');
  const sourceId = String(offer?.sourceId || '').trim();
  const externalId = String(offer?.externalId || '').trim();
  const scope = String(offer?.scope || '').trim();
  if (!sourceId || !externalId || externalId.length > 160) {
    throw new Error('Source et externalId stable obligatoires pour enregistrer une offre.');
  }
  if (!['store', 'brand', 'online'].includes(scope)) {
    throw new Error(`Périmètre d'offre invalide : ${scope || '(vide)'}`);
  }

  const placeId = scope === 'store' ? Number(offer.placeId) : null;
  const brandKey = String(offer.brandKey ?? '').trim().toLowerCase();
  if (scope === 'store' && (!Number.isSafeInteger(placeId) || placeId < 1)) {
    throw new Error('Une offre de magasin doit fournir un placeId valide.');
  }
  if (scope !== 'store' && !brandKey) {
    throw new Error('Une offre enseigne ou en ligne doit fournir un brandKey.');
  }

  const result = await db.query(`
    INSERT INTO offers (
      source_id,external_id,place_id,brand_key,title,description,offer_type,scope,
      discount_label,promo_code,landing_url,source_url,source_name,terms,
      valid_from,valid_until,status,verified_at,catalog_items,updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,NOW())
    ON CONFLICT (source_id,external_id) DO UPDATE SET
      place_id=EXCLUDED.place_id,
      brand_key=EXCLUDED.brand_key,
      title=EXCLUDED.title,
      description=EXCLUDED.description,
      offer_type=EXCLUDED.offer_type,
      scope=EXCLUDED.scope,
      discount_label=EXCLUDED.discount_label,
      promo_code=EXCLUDED.promo_code,
      landing_url=EXCLUDED.landing_url,
      source_url=EXCLUDED.source_url,
      source_name=EXCLUDED.source_name,
      terms=EXCLUDED.terms,
      valid_from=EXCLUDED.valid_from,
      valid_until=EXCLUDED.valid_until,
      status=EXCLUDED.status,
      verified_at=EXCLUDED.verified_at,
      catalog_items=CASE
        WHEN jsonb_array_length(EXCLUDED.catalog_items)>0
        THEN EXCLUDED.catalog_items
        ELSE offers.catalog_items
      END,
      updated_at=NOW()
    RETURNING id
  `, [
    sourceId,
    externalId,
    placeId,
    brandKey,
    offer.title,
    offer.description ?? null,
    offer.offerType,
    scope,
    offer.discountLabel ?? null,
    offer.promoCode ?? null,
    offer.landingUrl ?? null,
    offer.sourceUrl,
    offer.sourceName ?? null,
    offer.terms ?? null,
    offer.validFrom ?? null,
    offer.validUntil ?? null,
    offer.status || 'draft',
    offer.verifiedAt ?? null,
    JSON.stringify(Array.isArray(offer.catalogItems) ? offer.catalogItems : []),
  ]);

  return result.rows[0];
}

export async function runOfferSource({ db, sourceId, collector, dryRun = false, logger = console }) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query requis');
  if (!sourceId || typeof collector !== 'function') throw new TypeError('sourceId et collector requis');

  let runId = null;
  try {
    if (!dryRun) {
      const started = await db.query(
        `INSERT INTO offer_sync_runs (source_id,status) VALUES ($1,'failed') RETURNING id`,
        [sourceId],
      );
      runId = started.rows?.[0]?.id ?? null;
      if (runId === null) throw new Error('Le journal de collecte n’a pas retourné son identifiant.');
    }

    const result = await collector();
    if (!result || !Array.isArray(result.offers)
      || (result.warnings !== undefined && !Array.isArray(result.warnings))) {
      throw new Error('Le collecteur a retourné un résultat invalide.');
    }
    const warnings = result.warnings || [];

    let saved = 0;
    safeLog(logger, 'log', `[${sourceId}] Offres détectées : ${result.offers.length}`);
    const status = warnings.length ? 'partial' : 'success';

    if (dryRun) {
      for (const offer of result.offers) {
        safeLog(logger, 'log', '[SIMULATION]', JSON.stringify({
          externalId: offer.externalId,
          title: offer.title,
          discountLabel: offer.discountLabel,
          validFrom: offer.validFrom,
          validUntil: offer.validUntil,
          status: offer.status,
          scope: offer.scope,
          catalogItems: Array.isArray(offer.catalogItems) ? offer.catalogItems.length : 0,
        }));
      }
    } else {
      if (typeof db.connect !== 'function') {
        throw new Error('Le pool PostgreSQL doit fournir connect() pour écrire les offres dans une transaction atomique.');
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        for (const offer of result.offers) {
          await upsertOffer(client, offer);
          saved += 1;
        }
        await client.query(`
          UPDATE offer_sync_runs
             SET status=$2,finished_at=NOW(),offers_seen=$3,offers_upserted=$4,details=$5::jsonb
           WHERE id=$1
        `, [runId, status, result.offers.length, saved, JSON.stringify({
          ...(result.details || {}),
          warnings: warnings.slice(0, 20),
        })]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    safeLog(logger, 'log', `[${sourceId}] ${status} — ${result.offers.length} détectée(s), ${dryRun ? '0' : saved} enregistrée(s).`);
    for (const warning of warnings.slice(0, 5)) {
      safeLog(logger, 'warn', `[${sourceId}] Avertissement : ${warning}`);
    }
    return { ok: true, sourceId, status, offersSeen: result.offers.length, offersUpserted: saved };
  } catch (error) {
    safeLog(logger, 'error', `[${sourceId}] Collecte échouée :`, error.message);
    let journalError = null;
    if (!dryRun && runId !== null) {
      try {
        await db.query(`
          UPDATE offer_sync_runs
             SET status='failed',finished_at=NOW(),error=$2
           WHERE id=$1
        `, [runId, String(error.message || error).slice(0, 2000)]);
      } catch (failure) {
        journalError = failure;
        safeLog(logger, 'error', `[${sourceId}] Impossible de journaliser l'échec :`, failure.message);
      }
    }
    return {
      ok: false,
      sourceId,
      error: error.message || String(error),
      journalError: journalError?.message ?? null,
    };
  }
}
