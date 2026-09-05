// ============================================================
// APP_ROLE — split proceso app (bot/webhooks) vs scraper
// ============================================================

export type AppRole = 'app' | 'scraper' | 'all';

export function getAppRole(): AppRole {
  const r = (process.env['APP_ROLE'] ?? 'all').trim().toLowerCase();
  if (r === 'app' || r === 'scraper') return r;
  return 'all';
}

export function runsAppWorkload(): boolean {
  const r = getAppRole();
  return r === 'app' || r === 'all';
}

export function runsScraperWorkload(): boolean {
  const r = getAppRole();
  return r === 'scraper' || r === 'all';
}
