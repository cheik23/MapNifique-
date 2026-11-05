// Vercel Serverless Function — proxy Awin Link Builder.
// Le token OAuth2 reste ici, côté serveur (process.env.AWIN_API_TOKEN) :
// il n'est jamais envoyé au navigateur ni inclus dans le bundle.
//
// POST /api/awin
// { "advertiserId": "12345", "destinationUrl": "https://..." }
// L'identifiant éditeur vient de process.env.AWIN_PUBLISHER_ID (jamais du client).
// → 200 { "url": "https://www.awin1.com/..." }
// → 4xx/5xx { "error": "..." }

const AWIN_API_BASE = 'https://api.awin.com';
const REQUEST_TIMEOUT_MS = 8000;

// Domaines de destination autorisés : n'ajouter que les annonceurs réellement
// utilisés. Tout autre domaine est refusé (évite d'être un générateur de liens
// ouvert à n'importe quelle URL).
const ALLOWED_DESTINATION_HOSTS = new Set(['www.amazon.fr']);

const sendJson = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
};

// Vercel parse déjà le JSON dans req.body pour la plupart des requêtes, mais on
// gère aussi le cas d'un corps brut (selon le runtime utilisé).
const readJsonBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

// La réponse du Link Builder peut varier : on accepte les champs courants.
const extractTrackingUrl = (data) => {
  if (typeof data === 'string' && data) return data;
  if (!data || typeof data !== 'object') return null;
  return (
    data.url ||
    data.trackingUrl ||
    data.link ||
    (Array.isArray(data) ? data[0]?.url : null) ||
    null
  );
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Méthode non autorisée : utiliser POST.' });
  }

  // Contrôle d'origine (navigateur) : APP_ORIGIN = https://ton-domaine.vercel.app
  const allowedOrigin = process.env.APP_ORIGIN;
  if (allowedOrigin && (req.headers.origin || '') !== allowedOrigin) {
    return sendJson(res, 403, { error: 'Origine non autorisée.' });
  }

  const token = process.env.AWIN_API_TOKEN;
  const publisherId = process.env.AWIN_PUBLISHER_ID;
  if (!token || !publisherId || !/^\d+$/.test(publisherId)) {
    // Message explicite : la variable doit être définie dans Vercel
    // (Settings → Environment Variables) ou dans .env pour `vercel dev`.
    return sendJson(res, 500, {
      error: 'Configuration serveur incomplète (AWIN_API_TOKEN / AWIN_PUBLISHER_ID).',
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Corps de requête JSON invalide.' });
  }

  const { advertiserId, destinationUrl } = body || {};

  if (!/^\d+$/.test(String(advertiserId || ''))) {
    return sendJson(res, 400, { error: 'advertiserId manquant ou non numérique.' });
  }
  let destination = null;
  try {
    destination = new URL(String(destinationUrl || ''));
  } catch {
    destination = null;
  }
  if (!destination || destination.protocol !== 'https:' || !ALLOWED_DESTINATION_HOSTS.has(destination.hostname)) {
    return sendJson(res, 400, { error: 'Destination non autorisée.' });
  }

  const endpoint = `${AWIN_API_BASE}/publishers/${encodeURIComponent(publisherId)}/linkbuilder/generate`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ advertiserId, destinationUrl: destination.toString() }),
      signal: controller.signal,
    });

    const raw = await response.text();

    if (!response.ok) {
      // On renvoie le détail côté serveur (utile au débogage) sans jamais
      // exposer le token.
      console.error('[awin] HTTP', response.status, raw.slice(0, 500));
      return sendJson(res, 502, { error: `Awin a répondu HTTP ${response.status}.` });
    }

    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }

    const url = extractTrackingUrl(data);
    if (!url) {
      console.error('[awin] réponse sans URL', raw.slice(0, 500));
      return sendJson(res, 502, { error: 'Réponse Awin sans URL de suivi.' });
    }

    return sendJson(res, 200, { url });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return sendJson(res, 504, { error: 'Awin n\'a pas répondu dans le délai imparti.' });
    }
    console.error('[awin] appel impossible', error?.message || error);
    return sendJson(res, 502, { error: 'Appel Awin impossible.' });
  } finally {
    clearTimeout(timeoutId);
  }
}
