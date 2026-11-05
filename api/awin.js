// Vercel Serverless Function — proxy Awin Link Builder.
// Le token OAuth2 reste ici, côté serveur (process.env.AWIN_API_TOKEN) :
// il n'est jamais envoyé au navigateur ni inclus dans le bundle.
//
// POST /api/awin
// { "publisherId": "123456", "advertiserId": "12345", "destinationUrl": "https://..." }
// → 200 { "url": "https://www.awin1.com/..." }
// → 4xx/5xx { "error": "..." }

const AWIN_API_BASE = 'https://api.awin.com';
const REQUEST_TIMEOUT_MS = 8000;

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

  const token = process.env.AWIN_API_TOKEN;
  if (!token) {
    // Message explicite : la variable doit être définie dans Vercel
    // (Settings → Environment Variables) ou dans .env pour `vercel dev`.
    return sendJson(res, 500, {
      error: 'AWIN_API_TOKEN absent : configurez la variable d\'environnement Vercel.',
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Corps de requête JSON invalide.' });
  }

  const { publisherId, advertiserId, destinationUrl } = body || {};

  if (!publisherId || !/^\d+$/.test(String(publisherId))) {
    return sendJson(res, 400, { error: 'publisherId manquant ou non numérique.' });
  }
  if (!advertiserId || String(advertiserId).trim() === '') {
    return sendJson(res, 400, { error: 'advertiserId manquant.' });
  }
  if (!destinationUrl || !/^https:\/\//i.test(String(destinationUrl))) {
    return sendJson(res, 400, { error: 'destinationUrl doit être une URL https://.' });
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
      body: JSON.stringify({ advertiserId, destinationUrl }),
      signal: controller.signal,
    });

    const raw = await response.text();

    if (!response.ok) {
      // On renvoie le détail côté serveur (utile au débogage) sans jamais
      // exposer le token.
      return sendJson(res, 502, {
        error: `Awin a répondu HTTP ${response.status}.`,
        details: raw.slice(0, 500),
      });
    }

    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }

    const url = extractTrackingUrl(data);
    if (!url) {
      return sendJson(res, 502, {
        error: 'Réponse Awin sans URL de suivi.',
        details: raw.slice(0, 500),
      });
    }

    return sendJson(res, 200, { url });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return sendJson(res, 504, { error: 'Awin n\'a pas répondu dans le délai imparti.' });
    }
    return sendJson(res, 502, { error: `Appel Awin impossible : ${error?.message || error}` });
  } finally {
    clearTimeout(timeoutId);
  }
}
