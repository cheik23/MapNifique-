/** Parse an optional numeric input as a bounded safe integer. */
export function parseBoundedInteger(value, {
  fallback,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
  label = 'La valeur',
} = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return fallback;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new RangeError(`${label} doit être un entier compris entre ${min} et ${max}.`);
  }
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw new RangeError(`${label} doit être un entier compris entre ${min} et ${max}.`);
  }
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${label} doit être un entier compris entre ${min} et ${max}.`);
  }
  return parsed;
}
