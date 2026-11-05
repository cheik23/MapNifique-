/**
 * Gestionnaire d'appels API avec cache persistant (IndexedDB).
 *
 * But : ne pas re-interroger Nominatim / Navitia pour une requête identique
 * deja effectuee dans les 24 h, afin de respecter les quotas des offres
 * gratuites. Si IndexedDB est indisponible, un cache memoire prend le relais.
 */

import { dbGet, dbSet } from './db.js';

// Store IndexedDB dedie (declare dans db.js, version 3).
const STORE = 'cache';
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// Repli memoire si IndexedDB echoue (navigation privee, quota plein, etc.).
const memoryCache = new Map();

/** Cle de cache lisible et stable. */
export const buildCacheKey = (namespace, parts = []) => `${namespace}:${parts.join('|')}`;

const readEntry = async (key) => {
  try {
    const entry = await dbGet(STORE, key);
    if (entry) return entry;
  } catch (error) {
    console.warn('[Cache] Lecture IndexedDB impossible :', error?.message || error);
  }
  return memoryCache.get(key) || null;
};

const writeEntry = async (entry) => {
  memoryCache.set(entry.key, entry);
  try {
    await dbSet(STORE, undefined, entry);
  } catch (error) {
    console.warn('[Cache] Ecriture IndexedDB impossible :', error?.message || error);
  }
};

/**
 * Lit une entree de cache.
 * @returns {Promise<{hit: boolean, data: any, savedAt?: number, expiresAt?: number}>}
 */
export const readCache = async (key) => {
  const entry = await readEntry(key);
  if (!entry) return { hit: false, data: null };
  if (Number(entry.expiresAt) <= Date.now()) return { hit: false, data: null, expired: true };
  return { hit: true, data: entry.data, savedAt: entry.savedAt, expiresAt: entry.expiresAt };
};

/** Ecrit une entree de cache (donnees JSON serialisables). */
export const writeCache = async (key, data, ttlMs = DEFAULT_TTL_MS) => {
  const now = Date.now();
  await writeEntry({ key, data, savedAt: now, expiresAt: now + ttlMs });
};

/**
 * GET JSON avec cache : renvoie le resultat memorise s'il est encore valide,
 * sinon effectue la requete puis memorise la reponse.
 *
 * @returns {Promise<{data: any, cached: boolean}>}
 */
export const cachedJson = async (key, url, { ttlMs = DEFAULT_TTL_MS, init } = {}) => {
  const cached = await readCache(key);
  if (cached.hit) return { data: cached.data, cached: true };

  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  await writeCache(key, data, ttlMs);
  return { data, cached: false };
};

/** Vide le cache memoire (utile aux tests ; IndexedDB garde ses entrees). */
export const clearMemoryCache = () => memoryCache.clear();
