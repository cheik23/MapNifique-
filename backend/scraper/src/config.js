import 'dotenv/config';

const positiveInteger = (value, fallback, maximum = 1_000_000) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
};

const workerJobLeaseMs = Math.max(
  60_000,
  positiveInteger(process.env.WORKER_JOB_LEASE_MS, 15 * 60_000, 24 * 60 * 60_000),
);
const workerJobHeartbeatMs = Math.min(
  Math.max(10_000, positiveInteger(process.env.WORKER_JOB_HEARTBEAT_MS, 60_000, 10 * 60_000)),
  Math.floor(workerJobLeaseMs / 3),
);

/** Devise par défaut : seulement si explicitement configurée. Jamais EUR implicite. */
const configuredDefaultCurrency = String(process.env.DEFAULT_CURRENCY || '').trim().toUpperCase();

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: positiveInteger(process.env.PORT, 8787, 65_535),
  databaseUrl: process.env.DATABASE_URL,
  trustedProxyIps: [...new Set(
    (process.env.TRUSTED_PROXY_IPS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  )],
  rateLimits: {
    windowMs: positiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 3_600_000),
    publicLimit: positiveInteger(process.env.API_RATE_LIMIT_PER_MINUTE, 180),
    searchLimit: positiveInteger(process.env.SEARCH_RATE_LIMIT_PER_MINUTE, 90),
    adminLimit: positiveInteger(process.env.ADMIN_RATE_LIMIT_PER_MINUTE, 30),
    maxClients: positiveInteger(process.env.RATE_LIMIT_MAX_CLIENTS, 5_000),
  },
  corsOrigins: [...new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://mapnifique.vercel.app',
    'https://mapnifique.pages.dev',
    ...(process.env.CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  ])],
  workerPollMs: Math.max(1000, positiveInteger(process.env.WORKER_POLL_MS, 3000, 60_000)),
  workerJobLeaseMs,
  workerJobHeartbeatMs,
  workerJobRetryDelayMs: positiveInteger(process.env.WORKER_JOB_RETRY_DELAY_MS, 5 * 60_000, 24 * 60 * 60_000),
  workerJobMaxAttempts: positiveInteger(process.env.WORKER_JOB_MAX_ATTEMPTS, 3, 10),
  hardMaxPages: positiveInteger(process.env.HARD_MAX_PAGES, 2000, 20_000),
  defaultMaxPages: Math.min(
    positiveInteger(process.env.DEFAULT_MAX_PAGES, 100, 20_000),
    positiveInteger(process.env.HARD_MAX_PAGES, 2000, 20_000),
  ),
  defaultMaxConcurrency: Math.min(2, positiveInteger(process.env.DEFAULT_MAX_CONCURRENCY, 2, 100)),
  defaultRequestsPerMinute: positiveInteger(process.env.DEFAULT_REQUESTS_PER_MINUTE, 12, 120),
  defaultSameDomainDelaySecs: positiveInteger(process.env.DEFAULT_SAME_DOMAIN_DELAY_SECS, 2, 60),

  /** Identité et staging. */
  candidateBudgetPerJob: positiveInteger(process.env.CANDIDATE_BUDGET_PER_JOB, 12_000, 200_000),
  candidateRetentionDays: positiveInteger(process.env.CANDIDATE_RETENTION_DAYS, 7, 365),
  anomalyArchiveDays: positiveInteger(process.env.ANOMALY_ARCHIVE_DAYS, 400, 3650),
  defaultCurrency: /^[A-Z]{3}$/.test(configuredDefaultCurrency) ? configuredDefaultCurrency : null,

  /** Politique d'échec de page : au-delà, le job échoue explicitement. */
  maxPageFailures: positiveInteger(process.env.MAX_PAGE_FAILURES, 5, 100),
  requestRetryLimit: positiveInteger(process.env.REQUEST_RETRY_LIMIT, 2, 5),
  navigationTimeoutSecs: positiveInteger(process.env.NAVIGATION_TIMEOUT_SECS, 35, 120),
  requestHandlerTimeoutSecs: positiveInteger(process.env.REQUEST_HANDLER_TIMEOUT_SECS, 60, 300),
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL absent. Copie .env.example vers .env et configure le mot de passe PostgreSQL.');
}
