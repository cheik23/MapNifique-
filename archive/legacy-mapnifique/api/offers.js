// Vercel Serverless Function — bons plans en ligne (Awin Offers API).
// Le token reste côté serveur (AWIN_API_TOKEN) et n'est jamais renvoyé.
//
// GET /api/offers?type=all|voucher|promotion
// → 200 { offers: [{ id, type, advertiser, title, description, terms, endDate, code, url }] }
// → 503 { error: 'not_configured' } si les variables serveur manquent
//
// Le résultat est mis en cache par le CDN (15 min) : cela protège la limite
// d'Awin (20 appels/minute) quel que soit le trafic.

const AWIN_API_BASE = 'https://api.awin.com';
const REQUEST_TIMEOUT_MS = 8000;
const ALLOWED_TYPES = new Set(['all', 'voucher', 'promotion']);
const PAGE_SIZE = 100;

const sendJson = (res, status, payload, cacheControl = 'no-store') => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Powered-By', 'MapNifique');
  res.end(JSON.stringify(payload));
};

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// La forme exacte de la réponse peut varier : on accepte un tableau ou un objet qui en contient un.
const pickList = (data) => {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['data', 'promotions', 'offers', 'content']) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
};

// On ne renvoie que les champs utiles, et seulement les offres avec un lien de suivi https.
const normalizeOffer = (offer) => {
  const url = typeof offer?.urlTracking === 'string' ? offer.urlTracking : '';
  if (!/^https:\/\//i.test(url)) return null;
  if (offer?.advertiser?.joined === false) return null;
  const code = offer?.voucher?.code ? clip(offer.voucher.code, 60) : null;
  return {
    id: offer.promotionId ?? null,
    type: offer.type === 'voucher' ? 'voucher' : 'promotion',
    advertiser: clip(offer?.advertiser?.name, 80),
    title: clip(offer.title, 140),
    description: clip(offer.description, 300),
    terms: clip(offer.terms, 400),
    endDate: offer.endDate || null,
    code,
    url,
  };
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Méthode non autorisée : utiliser GET.' });
  }

  const token = process.env.AWIN_API_TOKEN;
  const publisherId = process.env.AWIN_PUBLISHER_ID;
  if (!token || !publisherId || !/^\d+$/.test(publisherId)) {
    return sendJson(res, 503, { error: 'not_configured' });
  }

  let type = 'all';
  try {
    const asked = new URL(req.url, 'http://localhost').searchParams.get('type');
    if (asked && ALLOWED_TYPES.has(asked)) type = asked;
  } catch {
    // paramètre illisible : on garde « all »
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${AWIN_API_BASE}/publisher/${encodeURIComponent(publisherId)}/promotions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filters: { membership: 'joined', regionCodes: ['FR'], status: 'active', type },
        pagination: { page: 1, pageSize: PAGE_SIZE },
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      console.error('[offers] HTTP', response.status, raw.slice(0, 500));
      return sendJson(res, 502, { error: 'Le service d\'offres est indisponible.' });
    }

    let data;
    try {
      data = raw ? JSON.parse(raw) : [];
    } catch {
      console.error('[offers] réponse non JSON', raw.slice(0, 200));
      return sendJson(res, 502, { error: 'Réponse inattendue du service d\'offres.' });
    }

    const offers = pickList(data).map(normalizeOffer).filter(Boolean);
    return sendJson(res, 200, { offers }, 'public, s-maxage=900, stale-while-revalidate=3600');
  } catch (error) {
    console.error('[offers] appel impossible', error?.message || error);
    if (error?.name === 'AbortError') {
      return sendJson(res, 504, { error: 'Le service d\'offres n\'a pas répondu à temps.' });
    }
    return sendJson(res, 502, { error: 'Le service d\'offres est indisponible.' });
  } finally {
    clearTimeout(timeoutId);
  }
}
