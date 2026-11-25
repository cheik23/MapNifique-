const DEFAULT_USER_AGENT = 'MapNifique';
const MAX_ROBOTS_BYTES = 512 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const defaultRobotsCache = new Map();
const defaultRobotsInflight = new Map();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse robots.txt groups for one product token; malformed rules fail closed only when fetching. */
export function parseRobotsTxt(text, userAgent = DEFAULT_USER_AGENT) {
  const groups = [];
  let group = null;
  let groupHasRules = false;

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (name === 'user-agent') {
      if (!group || groupHasRules) {
        group = { agents: [], rules: [], crawlDelaySeconds: 0 };
        groups.push(group);
        groupHasRules = false;
      }
      if (value) group.agents.push(value.toLowerCase());
      continue;
    }

    if (!group) continue;
    if (name === 'allow' || name === 'disallow') {
      if (value) {
        group.rules.push({ type: name, path: value, specificity: value.replace(/[\*$]/g, '').length });
        groupHasRules = true;
      }
    } else if (name === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0 && delay <= 3600) {
        group.crawlDelaySeconds = Math.max(group.crawlDelaySeconds, delay);
        groupHasRules = true;
      }
    }
  }

  const token = String(userAgent || DEFAULT_USER_AGENT).toLowerCase();
  const matching = groups
    .map((candidate) => ({
      candidate,
      specificity: Math.max(0, ...candidate.agents
        .filter((agent) => agent === '*' || token.includes(agent))
        .map((agent) => agent === '*' ? 0 : agent.length)),
    }))
    .filter((entry) => entry.candidate.agents.some((agent) => agent === '*' || token.includes(agent)));

  if (!matching.length) return { rules: [], crawlDelaySeconds: 0 };
  const bestSpecificity = Math.max(...matching.map((entry) => entry.specificity));
  const selected = matching.filter((entry) => entry.specificity === bestSpecificity);

  return {
    rules: selected.flatMap((entry) => entry.candidate.rules),
    crawlDelaySeconds: Math.max(0, ...selected.map((entry) => entry.candidate.crawlDelaySeconds)),
  };
}

function ruleMatches(rulePath, requestPath) {
  const anchored = rulePath.endsWith('$');
  const source = anchored ? rulePath.slice(0, -1) : rulePath;
  const regex = source.split('*').map(escapeRegex).join('.*');
  return new RegExp(`^${regex}${anchored ? '$' : ''}`).test(requestPath);
}

export function isRobotsAllowed(policy, url) {
  const parsed = url instanceof URL ? url : new URL(url);
  const requestPath = `${parsed.pathname}${parsed.search}`;
  const matches = (policy?.rules || [])
    .filter((rule) => ruleMatches(rule.path, requestPath))
    .sort((a, b) => b.specificity - a.specificity || (a.type === 'allow' ? -1 : 1));
  return matches[0]?.type !== 'disallow';
}

async function readRobots(origin, {
  fetchImpl,
  userAgent,
  signalFactory,
  cache,
  inflight,
}) {
  const cached = cache.get(origin);
  if (cached) return cached;

  const pending = inflight.get(origin);
  if (pending) return pending;

  const read = (async () => {
    const robotsUrl = new URL('/robots.txt', origin).toString();
    const response = await fetchImpl(robotsUrl, {
      headers: { 'user-agent': `${userAgent}/2.0`, accept: 'text/plain' },
      signal: signalFactory(10000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      throw new Error(`Robots non vérifiable pour ${origin} (HTTP ${response.status}); collecte bloquée par défaut.`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_ROBOTS_BYTES) {
      throw new Error(`robots.txt dépasse ${MAX_ROBOTS_BYTES} octets pour ${origin}; collecte bloquée.`);
    }
    const policy = parseRobotsTxt(text, userAgent);
    cache.set(origin, policy);
    // Le délai robots commence après la requête robots.txt elle-même.
    originLastRequest.set(origin, Date.now());
    return policy;
  })();

  inflight.set(origin, read);
  try {
    return await read;
  } finally {
    if (inflight.get(origin) === read) inflight.delete(origin);
  }
}

const originQueues = new Map();
const originLastRequest = new Map();

async function waitForOrigin(origin, delayMs, sleepImpl) {
  const previous = originQueues.get(origin) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  originQueues.set(origin, current);
  await previous;
  try {
    const last = originLastRequest.get(origin) || 0;
    const waitMs = Math.max(0, delayMs - (Date.now() - last));
    if (waitMs > 0) await sleepImpl(waitMs);
    originLastRequest.set(origin, Date.now());
  } finally {
    release();
    if (originQueues.get(origin) === current) originQueues.delete(origin);
  }
}

/** Fetch an HTTP resource only after robots authorization for every redirect hop. */
export async function fetchRespectingRobots(url, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  // Cache partagé par origine : un même host ne doit pas retélécharger robots.txt
  // à chaque URL. Les tests peuvent injecter un cache isolé.
  const cache = options.cache || defaultRobotsCache;
  const inflight = options.inflight || defaultRobotsInflight;
  const minDelayMs = Math.max(0, Number(options.minDelayMs ?? 1000));
  const sleepImpl = options.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const signalFactory = options.signalFactory || ((ms) => AbortSignal.timeout(ms));
  const maxRedirects = Math.max(0, Math.min(10, Number(options.maxRedirects ?? 5)));
  let current = new URL(url);

  if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) {
    throw new Error('URL source non autorisée : HTTP(S) sans identifiants requis.');
  }

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const policy = await readRobots(current.origin, { fetchImpl, userAgent, signalFactory, cache, inflight });
    if (!isRobotsAllowed(policy, current)) {
      throw new Error(`Robots.txt interdit ${current.pathname} sur ${current.origin}; collecte bloquée.`);
    }

    await waitForOrigin(current.origin, Math.max(minDelayMs, policy.crawlDelaySeconds * 1000), sleepImpl);
    const response = await fetchImpl(current.toString(), {
      ...init,
      headers: { ...(init.headers || {}), 'user-agent': `${userAgent}/2.0` },
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers?.get?.('location');
    await response.body?.cancel?.().catch?.(() => {});
    if (!location) throw new Error(`Redirection HTTP ${response.status} sans en-tête Location.`);
    if (redirectCount === maxRedirects) throw new Error(`Trop de redirections HTTP (>${maxRedirects}).`);
    current = new URL(location, current);
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) {
      throw new Error('Redirection vers une URL non autorisée.');
    }
  }

  throw new Error('Redirection HTTP non résolue.');
}
