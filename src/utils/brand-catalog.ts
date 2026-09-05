import specs from '../data/car-specifications.json';
import { normalizeKey, normalizeBrand, normalizeModel } from './normalizer';

// ============================================================
// Catálogo de marcas (car-specifications.json) + bicicletas + remolques
// ============================================================

export const BICICLETAS_BRAND_NORM = 'bicicletas';
export const BICICLETAS_LABEL = 'Bicicletas';

export const REMOLQUE_BRAND_NORM = 'remolque';
export const REMOLQUE_LABEL = 'Remolque';

export const OTROS_BRAND_NORM = 'otros';
export const OTROS_LABEL = 'Otros';

const JUNK_BRAND_NORMS = new Set([
  'vehiculo',
  'vehículo',
  'vehiculos',
  'vehículos',
  'desconocida',
  'desconocido',
  'sin marca',
  'n a',
  'na',
  'otro',
  'otros',
  'varios',
  'generico',
  'genérico',
  'subasta',
  'lote',
  'furgoneta',
  'turismo',
  'camion',
  'camioneta',
  'motocicleta',
  'moto',
]);

/** Alias inventario → marca canónica del JSON */
const BRAND_ALIASES: Record<string, string> = {
  vw: 'volkswagen',
  volkswagon: 'volkswagen',
  mercedes: 'mercedes-benz',
  'mercedes benz': 'mercedes-benz',
  mercedesbenz: 'mercedes-benz',
  citroen: 'citroën',
  ds: 'ds automobiles',
  'ds automobiles': 'ds automobiles',
  landrover: 'land rover',
  'range rover': 'land rover',
  'rolls royce': 'rolls-royce',
  alfa: 'alfa romeo',
  'alfa romeo': 'alfa romeo',
  skoda: 'skoda',
  škoda: 'skoda',
  seat: 'seat',
  cupra: 'cupra',
  bmw: 'bmw',
  mini: 'mini',
  ssangyong: 'ssangyong / kgm',
  kgm: 'ssangyong / kgm',
  gwm: 'ora (gwm)',
  ora: 'ora (gwm)',
  'lynk co': 'lynk & co',
  'lynk&co': 'lynk & co',
  fiat: 'fiat',
  doblo: 'fiat',
  'doblò': 'fiat',
  harley: 'harley-davidson',
  'harley davidson': 'harley-davidson',
  harleydavidson: 'harley-davidson',
  sym: 'sym',
  vespa: 'vespa',
  aprilia: 'aprilia',
  ducati: 'ducati',
  triumph: 'triumph',
  kymco: 'kymco',
  derbi: 'derbi',
  'royal enfield': 'royal enfield',
  'moto guzzi': 'moto guzzi',
  'mv agusta': 'mv agusta',
  benelli: 'benelli',
  'cfmoto': 'cfmoto',
  keeway: 'keeway',
  voge: 'voge',
  zontes: 'zontes',
};

/** Marcas frecuentes en subastas que pueden no estar (o estar incompletas) en el JSON */
const EXTRA_BRANDS: Record<string, string> = {
  iveco: 'Iveco',
  man: 'MAN',
  daf: 'DAF',
  scania: 'Scania',
  isuzu: 'Isuzu',
  maxus: 'Maxus',
};

type SpecsFile = Record<string, Record<string, string[]>>;

const catalogByNorm = new Map<string, string>(); // norm -> display label
/** Marcas ordenadas por longitud (más largas primero) para matching en título */
let brandsByLength: Array<{ norm: string; label: string }> = [];
/** modelNorm -> { brandNorm, label } índice */
const modelIndex = new Map<string, Array<{ brandNorm: string; brandLabel: string; modelLabel: string }>>();

function bootCatalog(): void {
  if (catalogByNorm.size) return;
  const data = specs as SpecsFile;
  for (const label of Object.keys(data)) {
    const norm = normalizeKey(label);
    catalogByNorm.set(norm, label);
    catalogByNorm.set(norm.replace(/\s+/g, ''), label);
    const models = data[label] ?? {};
    for (const modelLabel of Object.keys(models)) {
      const mn = normalizeKey(modelLabel);
      if (!mn) continue;
      const list = modelIndex.get(mn) ?? [];
      list.push({ brandNorm: norm, brandLabel: label, modelLabel });
      modelIndex.set(mn, list);
      // también sin espacios
      const compact = mn.replace(/\s+/g, '');
      if (compact !== mn) {
        const list2 = modelIndex.get(compact) ?? [];
        list2.push({ brandNorm: norm, brandLabel: label, modelLabel });
        modelIndex.set(compact, list2);
      }
    }
  }
  catalogByNorm.set(BICICLETAS_BRAND_NORM, BICICLETAS_LABEL);
  catalogByNorm.set('bicicleta', BICICLETAS_LABEL);
  catalogByNorm.set(REMOLQUE_BRAND_NORM, REMOLQUE_LABEL);
  catalogByNorm.set('remolques', REMOLQUE_LABEL);
  catalogByNorm.set(OTROS_BRAND_NORM, OTROS_LABEL);

  for (const [norm, label] of Object.entries(EXTRA_BRANDS)) {
    catalogByNorm.set(norm, label);
  }

  brandsByLength = Array.from(catalogByNorm.entries())
    .filter(
      ([norm]) =>
        norm !== BICICLETAS_BRAND_NORM &&
        norm !== 'bicicleta' &&
        norm !== REMOLQUE_BRAND_NORM &&
        norm !== 'remolques' &&
        norm !== OTROS_BRAND_NORM
    )
    .map(([norm, label]) => ({ norm, label }))
    .filter((b, i, arr) => arr.findIndex((x) => x.label === b.label) === i)
    .sort((a, b) => b.norm.length - a.norm.length);
}

bootCatalog();

export function isJunkBrandLabel(raw?: string | null): boolean {
  if (!raw) return true;
  const t = raw.trim();
  if (!t) return true;
  if (/^\d+$/.test(t)) return true; // "2", "4", "5"
  if (t.length <= 1) return true;
  const n = normalizeKey(t);
  if (!n) return true;
  if (n === OTROS_BRAND_NORM || t === OTROS_LABEL) return false;
  if (JUNK_BRAND_NORMS.has(n)) return true;
  if (/^(vehiculo|vehicle|coche|auto|furgoneta)\b/.test(n) && n.split(' ').length <= 2) return true;
  return false;
}

export function resolveCatalogBrand(raw?: string | null): { norm: string; label: string } | null {
  bootCatalog();
  if (!raw || isJunkBrandLabel(raw)) return null;
  let n = normalizeKey(raw);
  if (!n) return null;

  if (BRAND_ALIASES[n]) n = normalizeKey(BRAND_ALIASES[n]);

  if (n === REMOLQUE_BRAND_NORM || n === 'remolques' || n === 'trailer') {
    return { norm: REMOLQUE_BRAND_NORM, label: REMOLQUE_LABEL };
  }
  if (n === OTROS_BRAND_NORM) {
    return { norm: OTROS_BRAND_NORM, label: OTROS_LABEL };
  }

  if (EXTRA_BRANDS[n]) {
    return { norm: n, label: EXTRA_BRANDS[n]! };
  }

  const direct = catalogByNorm.get(n) || catalogByNorm.get(n.replace(/\s+/g, ''));
  if (direct) {
    if (direct === BICICLETAS_LABEL) return { norm: BICICLETAS_BRAND_NORM, label: BICICLETAS_LABEL };
    if (direct === REMOLQUE_LABEL) return { norm: REMOLQUE_BRAND_NORM, label: REMOLQUE_LABEL };
    return { norm: normalizeKey(direct), label: direct };
  }

  for (const [norm, label] of catalogByNorm) {
    if (norm === BICICLETAS_BRAND_NORM || norm === REMOLQUE_BRAND_NORM) continue;
    if (n === norm || n.startsWith(norm + ' ') || norm.startsWith(n + ' ') || norm === n) {
      return { norm: normalizeKey(label === BICICLETAS_LABEL ? BICICLETAS_BRAND_NORM : label), label };
    }
  }
  return null;
}

const BIKE_HINTS = [
  'bicicleta',
  'bicicletas',
  'bici',
  'ebike',
  'e-bike',
  'e bike',
  'pedelec',
  'mountain bike',
  'mtb',
];

const TRAILER_HINTS = [
  'remolque',
  'remolques',
  'trailer',
  'semi-remolque',
  'semiremolque',
  'portacoches',
  'porta coches',
];

export function isBikeText(marca?: string | null, modelo?: string | null, titulo?: string | null): boolean {
  const text = `${marca ?? ''} ${modelo ?? ''} ${titulo ?? ''}`.toLowerCase();
  return BIKE_HINTS.some((h) => text.includes(h)) || normalizeKey(marca ?? '') === 'bicicleta' || normalizeKey(marca ?? '') === 'bicicletas';
}

export function isTrailerText(marca?: string | null, modelo?: string | null, titulo?: string | null): boolean {
  const text = `${marca ?? ''} ${modelo ?? ''} ${titulo ?? ''}`.toLowerCase();
  const n = normalizeKey(marca ?? '');
  if (n === REMOLQUE_BRAND_NORM || n === 'remolques' || n === 'trailer') return true;
  return TRAILER_HINTS.some((h) => text.includes(h));
}

export type BikeCategory =
  | 'electrica'
  | 'montana'
  | 'carretera'
  | 'plegable'
  | 'urbana'
  | 'infantil'
  | 'otras';

export const BIKE_CATEGORY_LABELS: Record<BikeCategory, string> = {
  electrica: 'Eléctrica',
  montana: 'Montaña / MTB',
  carretera: 'Carretera',
  plegable: 'Plegable',
  urbana: 'Urbana / Normal',
  infantil: 'Infantil',
  otras: 'Otras',
};

export type TrailerCategory = 'carga' | 'portacoches' | 'naval' | 'agricola' | 'otros';

export const TRAILER_CATEGORY_LABELS: Record<TrailerCategory, string> = {
  carga: 'Carga / Caja',
  portacoches: 'Portacoches',
  naval: 'Naval / Barco',
  agricola: 'Agrícola',
  otros: 'Otros',
};

export function detectBikeCategory(marca?: string | null, modelo?: string | null, titulo?: string | null): BikeCategory {
  const text = `${marca ?? ''} ${modelo ?? ''} ${titulo ?? ''}`.toLowerCase();
  if (/electric|el[eé]ctric|e-?bike|ebike|pedelec/.test(text)) return 'electrica';
  if (/monta[nñ]a|mountain|\bmtb\b|enduro|downhill|trail/.test(text)) return 'montana';
  if (/carretera|road|racing|racer|gravel/.test(text)) return 'carretera';
  if (/plegable|folding|fold/.test(text)) return 'plegable';
  if (/infantil|ni[nñ]o|kids|junior|niña/.test(text)) return 'infantil';
  if (/urban|paseo|city|normal|cl[aá]sic|vintage|trekking|h[ií]brida/.test(text)) return 'urbana';
  return 'otras';
}

export function detectTrailerCategory(marca?: string | null, modelo?: string | null, titulo?: string | null): TrailerCategory {
  const text = `${marca ?? ''} ${modelo ?? ''} ${titulo ?? ''}`.toLowerCase();
  if (/portacoche|porta.?coche|car.?carrier|autotransport/.test(text)) return 'portacoches';
  if (/barco|naval|lancha|embarcaci|yate/.test(text)) return 'naval';
  if (/agr[ií]cola|ganader|volquete|basculante/.test(text)) return 'agricola';
  if (/caja|carga|plataforma|abierto|cerrado|frigor/.test(text)) return 'carga';
  return 'otros';
}

export function isBicicletasBrand(norm?: string | null): boolean {
  return normalizeKey(norm ?? '') === BICICLETAS_BRAND_NORM;
}

export function isRemolqueBrand(norm?: string | null): boolean {
  return normalizeKey(norm ?? '') === REMOLQUE_BRAND_NORM;
}

export function isOtrosBrand(norm?: string | null): boolean {
  return normalizeKey(norm ?? '') === OTROS_BRAND_NORM;
}

export interface ParsedVehicleIdentity {
  marca: string;
  modelo: string;
  marcaNorm: string;
  modeloNorm: string;
  kind: 'car' | 'bike' | 'remolque' | 'otros';
}

/** Quita prefijos basura: "5 vehículos", "2x", "Furgoneta", etc. */
function cleanTitleForMatch(titulo: string): string {
  let t = titulo.trim();
  t = t.replace(/^subasta\s+de\s+/i, '');
  t = t.replace(/^\d+\s*[x×]?\s*(veh[ií]culos?|uds?\.?|unidades?)?\s*/i, '');
  t = t.replace(/^(lote|ref\.?|referencia)\s*[:#]?\s*\S+\s*/i, '');
  t = t.replace(
    /^(furgoneta|turismo|camioneta|cami[oó]n|motocicleta|moto|autom[oó]vil|scooter|ciclomotor)\s+/i,
    ''
  );
  // Quitar matrícula / refs de expediente al final
  t = t.replace(/\s*[-–—]\s*matr[ií]cula\b.*$/i, '');
  t = t.replace(/\s*matr[ií]cula\b.*$/i, '');
  t = t.replace(/\(\s*\d{4}\s*[-–V]\s*\d+.*?\)\s*$/i, '');
  t = t.replace(/\ben\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s*\([^)]+\))?\s*$/i, '');
  return t.trim();
}

function findBrandInText(textNorm: string): { norm: string; label: string; index: number } | null {
  bootCatalog();
  for (const b of brandsByLength) {
    const idx = textNorm.indexOf(b.norm);
    if (idx < 0) continue;
    // word boundary-ish
    const before = idx === 0 || /\s/.test(textNorm[idx - 1] ?? ' ');
    const afterIdx = idx + b.norm.length;
    const after = afterIdx >= textNorm.length || /\s/.test(textNorm[afterIdx] ?? ' ');
    if (before && after) return { ...b, index: idx };
  }
  // aliases
  for (const [alias, canon] of Object.entries(BRAND_ALIASES)) {
    const idx = textNorm.indexOf(alias);
    if (idx < 0) continue;
    const before = idx === 0 || /\s/.test(textNorm[idx - 1] ?? ' ');
    const afterIdx = idx + alias.length;
    const after = afterIdx >= textNorm.length || /\s/.test(textNorm[afterIdx] ?? ' ');
    if (!before || !after) continue;
    const label = catalogByNorm.get(normalizeKey(canon));
    if (label) return { norm: normalizeKey(label), label, index: idx };
  }
  return null;
}

function findModelForBrand(
  brandNorm: string,
  brandLabel: string,
  textAfterBrand: string
): { modelLabel: string; modelNorm: string } | null {
  bootCatalog();
  const data = (specs as SpecsFile)[brandLabel];
  const haystack = normalizeKey(textAfterBrand);

  if (data) {
    const models = Object.keys(data)
      .map((modelLabel) => ({ modelLabel, modelNorm: normalizeKey(modelLabel) }))
      .filter((m) => m.modelNorm.length >= 1)
      .sort((a, b) => b.modelNorm.length - a.modelNorm.length);

    for (const m of models) {
      if (haystack.includes(m.modelNorm)) {
        return m;
      }
      if (brandNorm === 'bmw' && /^serie\s+(\d)/.test(m.modelNorm)) {
        const serie = m.modelNorm.match(/^serie\s+(\d)/)?.[1];
        if (serie && new RegExp(`\\b${serie}\\d{2}\\b`).test(haystack.replace(/\s/g, ' '))) {
          return m;
        }
      }
    }
  }

  const tokens = haystack
    .split(/\s+/)
    .filter(
      (t) =>
        t &&
        !JUNK_BRAND_NORMS.has(t) &&
        !/^\d+$/.test(t) &&
        t.length > 1 &&
        !/^(matricula|extranjera|espa[nñ]a|granada|madrid|barcelona|almunecar)$/.test(t) &&
        !/^[a-z]{0,2}\d{3,4}[a-z]{2,3}$/i.test(t) // placas 7541FDW / 4623KKG
    )
    .slice(0, 3);
  if (tokens.length) {
    const modelLabel = tokens.join(' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { modelLabel, modelNorm: normalizeKey(modelLabel) };
  }
  return { modelLabel: 'Genérico', modelNorm: 'generico' };
}

/**
 * Extrae marca + modelo canónicos desde el título (catálogo JSON + remolque/bici).
 */
export function extractBrandModelFromTitle(titulo: string): ParsedVehicleIdentity | null {
  bootCatalog();
  if (!titulo?.trim()) return null;

  if (isTrailerText(null, null, titulo)) {
    const cat = detectTrailerCategory(null, null, titulo);
    const modelLabel = TRAILER_CATEGORY_LABELS[cat];
    return {
      marca: REMOLQUE_LABEL,
      modelo: modelLabel,
      marcaNorm: REMOLQUE_BRAND_NORM,
      modeloNorm: cat,
      kind: 'remolque',
    };
  }

  if (isBikeText(null, null, titulo)) {
    const cat = detectBikeCategory(null, null, titulo);
    const modelLabel = BIKE_CATEGORY_LABELS[cat];
    return {
      marca: BICICLETAS_LABEL,
      modelo: modelLabel,
      marcaNorm: BICICLETAS_BRAND_NORM,
      modeloNorm: cat,
      kind: 'bike',
    };
  }

  const cleaned = cleanTitleForMatch(titulo);
  const textNorm = normalizeKey(cleaned);
  if (!textNorm) return null;

  const brandHit = findBrandInText(textNorm);
  if (!brandHit) {
    // Sin marca del catálogo → Otros (para que cuente en el filtro)
    const tokens = textNorm
      .split(/\s+/)
      .filter((t) => t && !JUNK_BRAND_NORMS.has(t) && !/^\d+$/.test(t) && t.length > 1)
      .slice(0, 4);
    const modelLabel = tokens.length
      ? tokens.join(' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'Sin clasificar';
    return {
      marca: OTROS_LABEL,
      modelo: modelLabel.slice(0, 60),
      marcaNorm: OTROS_BRAND_NORM,
      modeloNorm: normalizeModel(modelLabel),
      kind: 'otros',
    };
  }

  const after = textNorm.slice(brandHit.index + brandHit.norm.length).trim();
  const modelHit = findModelForBrand(brandHit.norm, brandHit.label, after);
  const modelo = modelHit?.modelLabel ?? 'Genérico';
  const modeloNorm = modelHit?.modelNorm ?? 'generico';

  return {
    marca: brandHit.label,
    modelo,
    marcaNorm: normalizeBrand(brandHit.label),
    modeloNorm: normalizeModel(modeloNorm),
    kind: 'car',
  };
}

/** ¿La marca/modelo actuales ya son catálogo válido? */
export function identityLooksValid(marca?: string | null, modelo?: string | null): boolean {
  if (isJunkBrandLabel(marca)) return false;
  const n = normalizeKey(marca ?? '');
  if (isBicicletasBrand(n) || isRemolqueBrand(n) || isOtrosBrand(n)) {
    return Boolean(modelo?.trim());
  }
  const brand = resolveCatalogBrand(marca);
  if (!brand) return false;
  if (!modelo?.trim() || isJunkBrandLabel(modelo)) return false;
  if (/^\d+$/.test(modelo.trim())) return false;
  const mn = normalizeKey(modelo);
  if (mn.includes('vehiculo') || mn.includes('vehiculos')) return false;
  return true;
}
