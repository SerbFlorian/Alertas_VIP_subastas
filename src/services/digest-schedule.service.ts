/**
 * Horario digests por VIP (/horario).
 *
 * Prefs en Postgres (UsuarioVIP); cache Redis `digest:prefs:{id}` ~5 min.
 * Cadencia Redis sigue en warmup.service (`digest:next_regular:*`).
 *
 * Ventana: Europe/Madrid. Hard floor NOTIF_HARD_* (default 7–23).
 * Start UI: 07–12 · End UI: 19–23 · Intervalo: 1–4 h (default 2).
 */
import { prisma } from '../db/prisma';
import { getRedis, isRedisAvailable } from '../db/redis';

const PREFS_CACHE_TTL_SEC = 5 * 60;
const prefsMemory = new Map<string, { value: string; expiresAt: number }>();

function prefsKey(telegramId: string): string {
  return `digest:prefs:${telegramId}`;
}

async function cacheGet(key: string): Promise<string | null> {
  const mem = prefsMemory.get(key);
  if (mem) {
    if (mem.expiresAt > Date.now()) return mem.value;
    prefsMemory.delete(key);
  }
  const r = isRedisAvailable() ? getRedis() : null;
  if (!r) return null;
  try {
    return await r.get(key);
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: string, ttlSec: number): Promise<void> {
  prefsMemory.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  const r = isRedisAvailable() ? getRedis() : null;
  if (!r) return;
  try {
    await r.set(key, value, 'EX', ttlSec);
  } catch {
    /* ignore */
  }
}

async function cacheDel(key: string): Promise<void> {
  prefsMemory.delete(key);
  const r = isRedisAvailable() ? getRedis() : null;
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    /* ignore */
  }
}

export interface DigestPrefs {
  days: number[]; // ISO 1=Lun … 7=Dom
  startHour: number; // inclusiva
  endHour: number; // exclusiva
  intervalH: number; // 1|2|3|4
}

export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAYS_ONLY = [1, 2, 3, 4, 5] as const;

export const SCHEDULE_START_HOURS = [7, 8, 9, 10, 11, 12] as const;
export const SCHEDULE_END_HOURS = [19, 20, 21, 22, 23] as const;

function clampHourEnv(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) return fallback;
  return n;
}

export function hardStartHour(): number {
  return clampHourEnv(process.env['NOTIF_HARD_START_HOUR'], 7);
}

export function hardEndHour(): number {
  return clampHourEnv(process.env['NOTIF_HARD_END_HOUR'], 23);
}

export function allowedEndHoursAfter(startHour: number): number[] {
  return SCHEDULE_END_HOURS.filter((h) => h > startHour);
}

function snapToAllowed(hour: number, allowed: readonly number[]): number {
  if (allowed.includes(hour as (typeof allowed)[number])) return hour;
  let best = allowed[0]!;
  let bestDist = Math.abs(best - hour);
  for (const h of allowed) {
    const d = Math.abs(h - hour);
    if (d < bestDist) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}

/** Defaults nuevos VIP / Reset (NOTIF_WINDOW_* + intervalo). */
export function defaultDigestPrefs(): DigestPrefs {
  const hardStart = hardStartHour();
  const hardEnd = hardEndHour();
  let start = clampHourEnv(process.env['NOTIF_WINDOW_START_HOUR'], 8);
  let end = clampHourEnv(process.env['NOTIF_WINDOW_END_HOUR'], 21);
  start = snapToAllowed(Math.max(hardStart, Math.min(start, hardEnd - 1)), SCHEDULE_START_HOURS);
  const ends = allowedEndHoursAfter(start);
  end = snapToAllowed(
    Math.max(start + 1, Math.min(end, hardEnd)),
    ends.length ? ends : SCHEDULE_END_HOURS
  );
  if (end <= start) end = ends[0] ?? Math.min(start + 1, hardEnd);

  const fromMinutes = Math.round(
    Math.max(1, parseInt(process.env['NOTIFIER_INTERVAL_MINUTES'] ?? '120', 10)) / 60
  );
  const fromHours = parseInt(process.env['NOTIF_INTERVAL_HOURS'] ?? '', 10);
  const intervalRaw = Number.isFinite(fromHours) ? fromHours : fromMinutes;
  const intervalH = [1, 2, 3, 4].includes(intervalRaw) ? intervalRaw : 2;

  return {
    days: [...ALL_WEEKDAYS],
    startHour: start,
    endHour: end,
    intervalH,
  };
}

export function clampSchedulePrefs(raw: Partial<DigestPrefs> | null | undefined): DigestPrefs {
  const defaults = defaultDigestPrefs();
  const hardStart = hardStartHour();
  const hardEnd = hardEndHour();
  const allowedStarts = SCHEDULE_START_HOURS.filter((h) => h >= hardStart && h < hardEnd);

  let days = Array.isArray(raw?.days)
    ? [...new Set(raw!.days!.map((d) => Math.round(Number(d))).filter((d) => d >= 1 && d <= 7))]
    : [...defaults.days];
  if (days.length === 0) days = [...ALL_WEEKDAYS];
  days.sort((a, b) => a - b);

  let startHour = Number.isFinite(raw?.startHour) ? Math.round(raw!.startHour!) : defaults.startHour;
  let endHour = Number.isFinite(raw?.endHour) ? Math.round(raw!.endHour!) : defaults.endHour;

  startHour = Math.max(hardStart, startHour);
  startHour = snapToAllowed(startHour, allowedStarts.length ? allowedStarts : SCHEDULE_START_HOURS);
  const ends = allowedEndHoursAfter(startHour).filter((h) => h <= hardEnd);
  if (ends.length === 0) {
    startHour = snapToAllowed(Math.max(hardStart, 12), allowedStarts.length ? allowedStarts : SCHEDULE_START_HOURS);
    endHour = Math.min(hardEnd, Math.max(startHour + 1, 19));
  } else {
    endHour = snapToAllowed(endHour, ends);
    if (endHour <= startHour) endHour = ends[0]!;
    endHour = Math.min(endHour, hardEnd);
  }

  let intervalH = Number.isFinite(raw?.intervalH) ? Math.round(raw!.intervalH!) : defaults.intervalH;
  if (![1, 2, 3, 4].includes(intervalH)) intervalH = defaults.intervalH;

  return { days, startHour, endHour, intervalH };
}

/** Partes Europe/Madrid (no depende de TZ del proceso). */
export function madridParts(now = new Date()): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const wdRaw = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const map: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const weekday = map[wdRaw] ?? 1;
  let hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  if (hour === 24) hour = 0;
  return { weekday, hour };
}

export function isUserWithinDeliveryWindow(prefs: DigestPrefs, now = new Date()): boolean {
  const { weekday, hour } = madridParts(now);
  if (!prefs.days.includes(weekday)) return false;
  const { startHour: start, endHour: end } = prefs;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function prefsFromUserRow(row: {
  digest_days?: number[] | null;
  digest_start_hour?: number | null;
  digest_end_hour?: number | null;
  digest_interval_h?: number | null;
}): DigestPrefs {
  return clampSchedulePrefs({
    days: row.digest_days ?? undefined,
    startHour: row.digest_start_hour ?? undefined,
    endHour: row.digest_end_hour ?? undefined,
    intervalH: row.digest_interval_h ?? undefined,
  });
}

export async function invalidateDigestPrefsCache(telegramId: string): Promise<void> {
  await cacheDel(prefsKey(telegramId));
}

export async function loadDigestPrefs(telegramId: string): Promise<DigestPrefs> {
  const cached = await cacheGet(prefsKey(telegramId));
  if (cached) {
    try {
      return clampSchedulePrefs(JSON.parse(cached) as DigestPrefs);
    } catch {
      /* fall through */
    }
  }

  try {
    const user = await prisma.usuarioVIP.findUnique({
      where: { telegram_id: telegramId },
      select: {
        digest_days: true,
        digest_start_hour: true,
        digest_end_hour: true,
        digest_interval_h: true,
      },
    });
    const prefs = user ? prefsFromUserRow(user) : defaultDigestPrefs();
    await cacheSet(prefsKey(telegramId), JSON.stringify(prefs), PREFS_CACHE_TTL_SEC);
    return prefs;
  } catch {
    return defaultDigestPrefs();
  }
}

export async function saveDigestPrefs(
  telegramId: string,
  prefs: DigestPrefs
): Promise<DigestPrefs> {
  const clamped = clampSchedulePrefs(prefs);
  await prisma.usuarioVIP.update({
    where: { telegram_id: telegramId },
    data: {
      digest_days: clamped.days,
      digest_start_hour: clamped.startHour,
      digest_end_hour: clamped.endHour,
      digest_interval_h: clamped.intervalH,
    },
  });
  await invalidateDigestPrefsCache(telegramId);
  await cacheSet(prefsKey(telegramId), JSON.stringify(clamped), PREFS_CACHE_TTL_SEC);
  return clamped;
}

const DAY_SHORT_ES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

export function formatDigestDays(days: number[]): string {
  const sorted = [...new Set(days.filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Lun–Dom';
  if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) return 'L–V';
  if (sorted.length === 0) return 'Lun–Dom';
  return sorted.map((d) => DAY_SHORT_ES[d - 1]).join(', ');
}

export function formatHourRange(startHour: number, endHour: number): string {
  const pad = (h: number) => String(h).padStart(2, '0');
  return `${pad(startHour)}:00–${pad(endHour)}:00`;
}

export function intervalMsFromPrefs(prefs: DigestPrefs): number {
  return Math.max(1, prefs.intervalH) * 60 * 60 * 1000;
}

/** dueAt warmup: ahora+delay si cae en ventana del usuario; si no, próximo startHour Madrid + delay. */
export function calcularDueWarmupEnVentana(prefs: DigestPrefs, delayMin: number, now = Date.now()): number {
  const tentative = now + delayMin * 60_000;
  if (isUserWithinDeliveryWindow(prefs, new Date(tentative))) return tentative;

  // Buscar próximo instante Madrid = startHour:00 en un día permitido
  for (let i = 0; i < 14 * 24 * 60; i++) {
    const cand = now + i * 60_000;
    const d = new Date(cand);
    const { weekday, hour } = madridParts(d);
    const minute = parseInt(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Madrid',
        minute: 'numeric',
      }).format(d),
      10
    );
    if (prefs.days.includes(weekday) && hour === prefs.startHour && minute === 0) {
      return cand + delayMin * 60_000;
    }
  }
  return now + (12 * 60 + delayMin) * 60_000;
}
