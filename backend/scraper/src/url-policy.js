/** Enforce an exact HTTP(S) origin boundary for source-owned navigation. */
export function isSameOrigin(url, baseUrl) {
  try {
    const candidate = new URL(url);
    const base = new URL(baseUrl);
    if (candidate.username || candidate.password || base.username || base.password) return false;
    if (!['http:', 'https:'].includes(candidate.protocol) || !['http:', 'https:'].includes(base.protocol)) return false;
    return candidate.origin === base.origin;
  } catch {
    return false;
  }
}
