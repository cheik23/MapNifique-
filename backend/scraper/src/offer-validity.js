export function parseDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

export function getDateInTimeZone(date = new Date(), timeZone = 'Europe/Paris') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('Une date valide est requise.');
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function classifyOfferStatus(validFrom, validUntil, today = getDateInTimeZone()) {
  const start = validFrom == null || validFrom === ''
    ? null
    : parseDateOnly(validFrom);
  const end = parseDateOnly(validUntil);
  const currentDate = parseDateOnly(today);

  if (!currentDate || !end) return 'draft';
  if (validFrom != null && validFrom !== '' && !start) return 'draft';
  if (start && start > end) return 'draft';
  if (end < currentDate) return 'expired';
  if (start && start > currentDate) return 'draft';
  return 'active';
}

export function addCalendarYears(dateOnly, years) {
  const parsed = parseDateOnly(dateOnly);
  if (!parsed || !Number.isSafeInteger(years)) {
    throw new TypeError('Une date ISO et un nombre entier d’années sont requis.');
  }

  const [year, month, day] = parsed.split('-').map(Number);
  const targetYear = year + years;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, month, 0),
  ).getUTCDate();
  const targetDay = Math.min(day, lastDayOfTargetMonth);
  return `${String(targetYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

export async function applyOfferRetention(pool, today = getDateInTimeZone()) {
  const currentDate = parseDateOnly(today);
  if (!currentDate) throw new TypeError('La date de rétention doit être au format YYYY-MM-DD.');

  const cutoffDate = addCalendarYears(currentDate, -1);
  const expired = await pool.query(`
    UPDATE offers
       SET status='expired',updated_at=NOW()
     WHERE status='active'
       AND valid_until IS NOT NULL
       AND valid_until < $1::date
    RETURNING id
  `, [currentDate]);

  const deleted = await pool.query(`
    DELETE FROM offers
     WHERE status='expired'
       AND COALESCE(
         valid_until,
         (created_at AT TIME ZONE 'Europe/Paris')::date
       ) < $1::date
    RETURNING id
  `, [cutoffDate]);

  return {
    expired: Number(expired.rowCount || 0),
    deleted: Number(deleted.rowCount || 0),
    cutoffDate,
  };
}
