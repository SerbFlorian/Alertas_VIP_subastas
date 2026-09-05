// ============================================================
// Normalizers — canonical keys for matching & inventory UX
// ============================================================

const CCAA_CANON: Record<string, string> = {
  'andalucia': 'Andalucía',
  'andalucía': 'Andalucía',
  'aragon': 'Aragón',
  'aragón': 'Aragón',
  'asturias': 'Asturias',
  'principado de asturias': 'Asturias',
  'baleares': 'Baleares',
  'islas baleares': 'Baleares',
  'illes balears': 'Baleares',
  'canarias': 'Canarias',
  'cantabria': 'Cantabria',
  'castilla-la mancha': 'Castilla-La Mancha',
  'castilla la mancha': 'Castilla-La Mancha',
  'castilla y leon': 'Castilla y León',
  'castilla y león': 'Castilla y León',
  'cataluna': 'Cataluña',
  'cataluña': 'Cataluña',
  'catalunya': 'Cataluña',
  'extremadura': 'Extremadura',
  'galicia': 'Galicia',
  'madrid': 'Comunidad de Madrid',
  'comunidad de madrid': 'Comunidad de Madrid',
  'murcia': 'Región de Murcia',
  'region de murcia': 'Región de Murcia',
  'región de murcia': 'Región de Murcia',
  'navarra': 'Navarra',
  'comunidad foral de navarra': 'Navarra',
  'pais vasco': 'País Vasco',
  'país vasco': 'País Vasco',
  'euskadi': 'País Vasco',
  'la rioja': 'La Rioja',
  'rioja': 'La Rioja',
  'valencia': 'Comunidad Valenciana',
  'comunidad valenciana': 'Comunidad Valenciana',
  'comunitat valenciana': 'Comunidad Valenciana',
  'ceuta': 'Ceuta',
  'melilla': 'Melilla',
};

const STOP_TOKENS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'con', 'sin', 'para', 'por',
  'vehiculo', 'vehículo', 'coche', 'turismo', 'automovil', 'automóvil',
  'subasta', 'lote', 'ref', 'referencia',
]);

export function normalizeKey(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeBrand(raw?: string | null): string {
  return normalizeKey(raw);
}

export function normalizeModel(raw?: string | null): string {
  return normalizeKey(raw);
}

/** Canonical display CCAA (matches sanitizer output) */
export function canonicalizeCcaa(raw?: string | null): string {
  if (!raw) return '';
  const key = normalizeKey(raw);
  return CCAA_CANON[key] ?? raw.trim();
}

export function normalizeCcaa(raw?: string | null): string {
  return normalizeKey(canonicalizeCcaa(raw));
}

/** Distancia de edición (Levenshtein) acotada. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]!;
  }
  return prev[n]!;
}

function maxTypoDistance(phraseLen: number): number {
  if (phraseLen <= 5) return 1;
  if (phraseLen <= 10) return 2;
  return 3;
}

/** ¿`hay` contiene `needle` o una variante con 1–3 typos? */
function fuzzyContains(hay: string, needle: string): boolean {
  if (!needle || needle.length < 4) return false;
  if (hay.includes(needle)) return true;
  const maxD = maxTypoDistance(needle.length);
  const n = needle.length;
  for (let len = Math.max(4, n - 1); len <= n + 1; len++) {
    if (len > hay.length) continue;
    for (let i = 0; i <= hay.length - len; i++) {
      if (editDistance(hay.slice(i, i + len), needle) <= maxD) return true;
    }
  }
  return false;
}

/**
 * Detecta CCAA en texto libre (IA / recuperación).
 * Tolera mayúsculas, guiones, comas y faltas ortográficas leves.
 * Devuelve `ccaaNorm` canónico (el mismo que en BD / filtros).
 */
export function resolveCcaaNormFromText(text: string): string | undefined {
  const hay = normalizeKey(text);
  if (!hay) return undefined;

  // Alias cortos / typos frecuentes → etiqueta canónica
  const extraAliases: Record<string, string> = {
    clm: 'Castilla-La Mancha',
    cyl: 'Castilla y León',
    'castila la mancha': 'Castilla-La Mancha',
    'castilla la manca': 'Castilla-La Mancha',
    'castilla lamancha': 'Castilla-La Mancha',
    'castilla-lamancha': 'Castilla-La Mancha',
    'castila y leon': 'Castilla y León',
    'comunidad madrid': 'Comunidad de Madrid',
    'c madrid': 'Comunidad de Madrid',
    'pais vasqo': 'País Vasco',
    'comunitat valenciana': 'Comunidad Valenciana',
  };

  const phraseToLabel = new Map<string, string>();
  for (const [key, label] of Object.entries(CCAA_CANON)) {
    phraseToLabel.set(normalizeKey(key), label);
    phraseToLabel.set(normalizeKey(label), label);
  }
  for (const [key, label] of Object.entries(extraAliases)) {
    phraseToLabel.set(normalizeKey(key), label);
  }

  // Alias cortos exactos (CLM, CYL…) con límite de palabra
  for (const [key, label] of Object.entries(extraAliases)) {
    const nk = normalizeKey(key);
    if (nk.length >= 2 && nk.length <= 3) {
      if (new RegExp(`(?:^|\\s)${nk}(?:\\s|$)`).test(hay)) {
        return normalizeCcaa(label);
      }
    }
  }

  // Frases más largas primero (evitar que "leon" robe "castilla y leon")
  const phrases = [...phraseToLabel.keys()].filter((p) => p.length >= 4).sort((a, b) => b.length - a.length);

  for (const phrase of phrases) {
    if (fuzzyContains(hay, phrase)) {
      return normalizeCcaa(phraseToLabel.get(phrase));
    }
  }

  // Tokens distintivos sueltos (solo si no son ambiguos)
  if (/\bmancha\b/.test(hay)) return normalizeCcaa('Castilla-La Mancha');
  if (/\beuskadi\b|\bbizkaia\b|\bguipuzcoa\b|\bgipuzkoa\b/.test(hay)) {
    return normalizeCcaa('País Vasco');
  }
  // "Ibiza" solo como isla (evitar Seat Ibiza → Baleares)
  if (/\bmallorca\b|\bmenorca\b/.test(hay)) return normalizeCcaa('Baleares');
  if (/\bibiza\b/.test(hay) && !/\bseat\b/.test(hay) && !/\bmodelo\b/.test(hay)) {
    return normalizeCcaa('Baleares');
  }

  return undefined;
}

/**
 * Extract version/spec tokens from title + model for multi-select matching.
 */
export function extractVersionTokens(titulo: string, modelo?: string): string[] {
  const base = `${modelo ?? ''} ${titulo}`.toLowerCase();
  const cleaned = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s+\-./]/g, ' ');

  const parts = cleaned.split(/[\s,/|]+/).filter(Boolean);
  const tokens = new Set<string>();

  for (const p of parts) {
    const t = p.replace(/^\.+|\.+$/g, '');
    if (t.length < 2 || t.length > 24) continue;
    if (STOP_TOKENS.has(t)) continue;
    if (/^\d{5,}$/.test(t)) continue;
    tokens.add(t);
  }

  // Keep useful compound-ish tokens already split (e.g. tdi, dci, gti, 2.0)
  return Array.from(tokens).slice(0, 24);
}

export function fingerprintFiltros(input: {
  marcaNorm?: string | null;
  modeloNorm?: string | null;
  versions?: string[];
  ccaaNorms?: string[];
  puja_maxima?: number | null;
}): string {
  const versions = [...(input.versions ?? [])].map(normalizeKey).filter(Boolean).sort();
  const ccaa = [...(input.ccaaNorms ?? [])].map(normalizeKey).filter(Boolean).sort();
  return JSON.stringify({
    m: input.marcaNorm ?? '',
    mo: input.modeloNorm ?? '',
    v: versions,
    c: ccaa,
    p: input.puja_maxima ?? null,
  });
}

export function isUsableModelLabel(label?: string | null): boolean {
  if (!label) return false;
  const t = label.trim();
  if (t.length < 1 || t === '-' || t === '—' || t === 'n/a' || t === 'N/A') return false;
  if (normalizeKey(t).length < 1) return false;
  return true;
}

/** Matrícula ES típica: 1234-ABC / 1234 ABC */
const PLATE_RE = /\b\d{4}\s*-?\s*[A-ZÁÉÍÓÚÑ]{3}\b/gi;

/**
 * Clave semántica para no notificar 3 furgonetas idénticas de flota
 * (misma marca/modelo/puja/CCAA, distinta matrícula).
 */
export function semanticLotKey(input: {
  marca: string;
  modelo: string;
  titulo?: string;
  puja_minima: number;
  comunidad_autonoma?: string | null;
  portal?: string;
}): string {
  const text = `${input.marca} ${input.modelo} ${input.titulo ?? ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(PLATE_RE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const puja = Math.round(Number(input.puja_minima) || 0);
  const geo = (input.comunidad_autonoma ?? '').toLowerCase().trim();
  const portal = (input.portal ?? '').toLowerCase();
  return `${portal}|${text}|${puja}|${geo}`;
}

export function dedupeNearDuplicateLots<T extends {
  marca: string;
  modelo: string;
  titulo?: string;
  puja_minima: number;
  comunidad_autonoma?: string | null;
  portal?: string;
}>(lots: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const lot of lots) {
    const key = semanticLotKey(lot);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lot);
  }
  return out;
}
