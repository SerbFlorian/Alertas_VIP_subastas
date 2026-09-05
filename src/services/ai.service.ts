import OpenAI from 'openai';
import { getFiltrosUsuario, radarIsConfigured } from '../db/filters.queries';
import {
  puedeConsultarInventarioIA,
  consumirConsultaInventarioIA,
  getRecoveryQuotaStatus,
  incrementRecoveryUsage,
  AI_AD_RECOVERY_DAILY_MAX,
  AI_BROKEN_LINK_DAILY_MAX,
  type TipoRecuperacionFicha,
} from '../db/queries';
import { listBrandsFromInventory } from './inventory.service';
import { prisma } from '../db/prisma';
import { logger } from './logger';
import { resolveCcaaNormFromText } from '../utils/normalizer';
import { formatearPrecio } from './telegram.service';

// ============================================================
// Asesor IA de subastas — gpt-4o-mini
// Chat VIP: AI_VIP_DAILY_MAX / AI_VIP_WEEKLY_MAX (default 20/140)
// Ficha+enlace VIP:
//   - enlace roto → AI_BROKEN_LINK_DAILY_MAX (1/día)
//   - lote perdido → AI_AD_RECOVERY_DAILY_MAX (3/día)
// Free: 3 msgs; 1 ficha sin enlace al recuperar
// Consejo / comparar → texto solo (sin enlace)
// Timeout duro: 2 min
// ============================================================

const histories = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

const AI_TIMEOUT_MS = parseInt(process.env['AI_TIMEOUT_MS'] ?? String(2 * 60 * 1000), 10);

const MSG_AI_TIMEOUT =
  '⏱️ No he encontrado una subasta a tiempo (límite 2 min). Prueba a afinar marca, modelo, comunidad o puja e inténtalo de nuevo.';

const MSG_AI_NO_ENCONTRADO =
  '🔎 No he encontrado ninguna subasta que encaje con eso ahora mismo. Prueba a ampliar marca, comunidad o puja máxima.';

let cachedClient: OpenAI | null | undefined;

function getClient(): OpenAI | null {
  if (cachedClient !== undefined) return cachedClient;

  const key = (process.env['OPENAI_API_KEY'] ?? '').trim();
  if (!key) {
    cachedClient = null;
    return null;
  }

  cachedClient = new OpenAI({
    apiKey: key,
    timeout: AI_TIMEOUT_MS,
    maxRetries: 2,
    ...(typeof globalThis.fetch === 'function'
      ? { fetch: globalThis.fetch.bind(globalThis) as typeof fetch }
      : {}),
  });
  return cachedClient;
}

function isTransientAiError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes('premature close') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('timeout') ||
    lower.includes('429') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimHistory(telegramId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const h = histories.get(telegramId) ?? [];
  const trimmed = h.slice(-5);
  histories.set(telegramId, trimmed);
  return trimmed;
}

function rollbackLastUser(telegramId: string): void {
  const h = histories.get(telegramId) ?? [];
  if (h.length && h[h.length - 1]?.role === 'user') {
    h.pop();
    histories.set(telegramId, h);
  }
}

function pushAssistant(telegramId: string, content: string): void {
  const h = histories.get(telegramId) ?? [];
  h.push({ role: 'assistant', content });
  histories.set(telegramId, h.slice(-5));
}

async function filterContext(telegramId: string): Promise<string> {
  const f = await getFiltrosUsuario(telegramId);
  if (!radarIsConfigured(f)) {
    return 'El usuario aún no ha configurado su radar VIP (marca/modelo/CCAA/puja).';
  }
  return [
    `Radar VIP actual:`,
    `- Marca: ${f.marcaNorm || 'cualquiera'}`,
    `- Modelo: ${f.modeloNorm || 'cualquiera'}`,
    `- Comunidades: ${(f.ccaaNorms ?? []).join(', ') || 'toda España'}`,
    `- Puja máxima: ${f.puja_maxima != null ? f.puja_maxima + '€' : 'sin límite'}`,
  ].join('\n');
}

/** Comparar / consejo → nunca ficha ni enlace. */
function pareceConsejoSinFicha(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /\bvs\.?\b/.test(m) ||
    m.includes('compar') ||
    m.includes('diferencia') ||
    m.includes('merece la pena') ||
    m.includes('me conviene') ||
    m.includes('riesgo') ||
    m.includes('cómo pujar') ||
    m.includes('como pujar') ||
    m.includes('qué debo') ||
    m.includes('que debo') ||
    m.includes('consejo') ||
    m.includes('opinión') ||
    m.includes('opinion')
  );
}

/**
 * Clasifica si el mensaje pide ficha+enlace (enlace roto o recuperar lote).
 */
export function clasificarPeticionFicha(msg: string): TipoRecuperacionFicha | null {
  const m = msg.toLowerCase();

  const enlaceCaido = [
    'enlace caíd',
    'enlace caid',
    'link caíd',
    'link caid',
    'está caído',
    'esta caido',
    'enlace roto',
    'link roto',
    'no funciona el enlace',
    'no funciona el link',
    'dame una alternativa',
    'busca una alternativa',
    'otra alternativa',
    'alternativa al anuncio',
    'alternativa a la subasta',
  ].some((k) => m.includes(k));

  const recuperar = [
    'recuper',
    'reenvia',
    'he perdido',
    'perdí el',
    'perdi el',
    'perdí un',
    'perdi un',
    'anuncio encontrado',
    'subasta encontrada',
    'dame el anuncio',
    'dame el enlace',
    'dame el link',
    'pásame el enlace',
    'pasame el enlace',
    'pásame el link',
    'pasame el link',
    'link del anuncio',
    'enlace del anuncio',
    'link de la subasta',
    'enlace de la subasta',
    'muéstrame el anuncio',
    'muestrame el anuncio',
    'quiero el link',
    'quiero el enlace',
    'hay alguna',
    'hay algún',
    'hay algun',
    'qué hay en subasta',
    'que hay en subasta',
    'busca un',
    'buscar un',
    'enséñame un',
    'ensenyame un',
  ].some((k) => m.includes(k));

  const describeParaRecuperar =
    !pareceConsejoSinFicha(m) &&
    (m.includes('dacia') ||
      m.includes('audi') ||
      m.includes('bmw') ||
      m.includes('seat') ||
      m.includes('toyota') ||
      m.includes('mercedes') ||
      m.includes('opel') ||
      m.includes('renault') ||
      m.includes('ford') ||
      m.includes('peugeot') ||
      m.includes('volkswagen') ||
      m.includes('vw ') ||
      m.includes('coche') ||
      m.includes('vehículo') ||
      m.includes('vehiculo') ||
      m.includes('furgón') ||
      m.includes('furgon') ||
      m.includes('moto')) &&
    (/\d{2,6}\s*€/.test(m) ||
      /puja/.test(m) ||
      /galicia|madrid|catalu|andaluc|valencia|pa[ií]s vasco|euskadi|castilla|arag[oó]n|murcia|extremadura|navarra|rioja|asturias|cantabria|baleares|canarias/.test(
        m
      ));

  if (pareceConsejoSinFicha(m) && !enlaceCaido && !recuperar) {
    return null;
  }

  if (enlaceCaido) return 'enlace_roto';
  if (recuperar || describeParaRecuperar) return 'recuperacion';
  return null;
}

const SYSTEM_BASE = `Eres el asesor de Alertas VIP Subastas.
Hablas SIEMPRE en castellano (español de España), tono claro, profesional y cercano.
Ámbito: subastas de vehículos embargados en España (BOE, Escrapalia, eActivos, Procuradores).
No garantices adjudicación ni rentabilidad. Explica riesgos (estado, cargas, visita, depósito, plazos).
Nunca digas el precio de la suscripción VIP.
Mantén la conversación centrada en subastas, pujas, embargos, portales y vehículos.

═══════════════════════════════════════
FICHA + ENLACE — SOLO 2 CASOS
═══════════════════════════════════════
La app solo adjunta ficha + enlace «Subasta encontrada» en:
  A) RECUPERAR un lote perdido / pedir link de un anuncio concreto.
  B) Enlace caído / pedir alternativa.
En CUALQUIER otro mensaje (consejo de puja, riesgos, comparar marcas, “¿merece la pena?”) → SOLO texto de asesoría.
PROHIBIDO inventar lotes, pegar URLs o markdown [texto](url). Nunca inventes enlaces.

Si el sistema te pasa INVENTARIO_ACTUAL / FICHA_BD: resume esos datos reales.
Si no hay bloque de inventario: no cites lotes concretos ni enlaces.

FORMATO TELEGRAM (HTML):
- <b>texto</b> para datos clave.
- No pegues URLs a pelo: la app añade el enlace clicable en casos A/B.
- Párrafos cortos.`;

function systemAccess(esVip: boolean, modoFicha: boolean): string {
  if (esVip) {
    return modoFicha
      ? `ACCESO VIP — modo recuperación/alternativa: usa SOLO los datos de FICHA_BD. 1 frase corta; la app pega la ficha HTML + enlace.`
      : `ACCESO VIP — consejo: responde sin listar lotes ni enlaces. Para alertas continuas sugiere /filtros. Recuperar lote: que pida explícitamente el link.`;
  }
  return modoFicha
    ? `ACCESO GRATUITO — recuperación: puedes describir la ficha de FICHA_BD pero SIN enlace (la app oculta el link). Anima a VIP.`
    : `ACCESO GRATUITO — consejo verbal sin lotes ni enlaces. Menciona VIP para radar + enlaces.`;
}

export type AiReply = {
  ok: true;
  text: string;
  /** Sufijo de cupo recovery ya incluido en text si aplica */
} | { ok: false; text: string };

export async function handleAiMessage(telegramId: string, text: string): Promise<AiReply> {
  const client = getClient();
  if (!client) {
    return {
      ok: false,
      text: 'El asesor IA no está configurado todavía (falta OPENAI_API_KEY). Mientras tanto usa /filtros si eres VIP.',
    };
  }

  const history = trimHistory(telegramId);
  history.push({ role: 'user', content: text });
  histories.set(telegramId, history);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AI_TIMEOUT_MS);

  try {
    return await handleAiMessageInner(client, telegramId, text, history, ac.signal);
  } catch (error: unknown) {
    const aborted =
      ac.signal.aborted ||
      (error instanceof Error &&
        (error.name === 'AbortError' || error.message.toLowerCase().includes('abort')));

    if (aborted) {
      logger.warn('⏱️ Asesor IA: timeout', { telegramId, timeoutMs: AI_TIMEOUT_MS });
      rollbackLastUser(telegramId);
      // ok:false → el bot NO consume cupo freemium/VIP
      return { ok: false, text: MSG_AI_TIMEOUT };
    }

    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Error del asesor IA', { error: msg });
    rollbackLastUser(telegramId);
    return {
      ok: false,
      text: 'Ha habido un problema con el asesor IA. Inténtalo de nuevo en un momento.',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handleAiMessageInner(
  client: OpenAI,
  telegramId: string,
  text: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal: AbortSignal
): Promise<AiReply> {
  const user = await prisma.usuarioVIP.findUnique({
    where: { telegram_id: telegramId },
    select: { estado: true, ai_pruebas_usadas: true },
  });
  const esVip = user?.estado === 'Pagado' || user?.estado === 'Cancelando';
  const tipoFicha = clasificarPeticionFicha(text);
  const pideFicha = tipoFicha !== null;

  let lote: LoteFicha | null = null;
  let permitirBusqueda = false;
  let cupoNote = '';

  if (pideFicha && tipoFicha) {
    if (esVip) {
      const cupo = await getRecoveryQuotaStatus(telegramId, tipoFicha);
      if (!cupo.permitido) {
        rollbackLastUser(telegramId);
        return {
          ok: false,
          text:
            `⏳ <b>Cupo agotado</b>\n\n` +
            (cupo.motivo ?? 'Límite diario de recuperaciones alcanzado. Se reinicia mañana.'),
        };
      }
      permitirBusqueda = true;
    } else {
      // Free: 1 ficha sin enlace (cupo inventario free)
      const cupo = await puedeConsultarInventarioIA(telegramId, false);
      permitirBusqueda = cupo.ok;
      if (!cupo.ok) {
        // Sigue el chat de consejo sin ficha
        permitirBusqueda = false;
      }
    }
  }

  if (permitirBusqueda) {
    if (signal.aborted) throw new Error('AbortError');
    lote = await buscarLoteEnBd(telegramId, text);
  }

  // Sin stock en modo ficha → no consumir cupo recovery; chat sí se cobra fuera
  if (pideFicha && permitirBusqueda && !lote) {
    const after =
      esVip && tipoFicha ? await getRecoveryQuotaStatus(telegramId, tipoFicha) : null;
    let texto = MSG_AI_NO_ENCONTRADO;
    if (after) {
      texto += `\n\n<i>Cupo ${tipoFicha === 'enlace_roto' ? 'enlace roto' : 'recuperación'}: ${after.usadoHoy}/${after.maxHoy} hoy.</i>`;
    }
    pushAssistant(telegramId, texto);
    return { ok: true, text: texto };
  }

  if (lote && permitirBusqueda) {
    const incluirEnlace = esVip;
    let texto = componerFichaLote(lote, incluirEnlace);

    if (esVip && tipoFicha && lote.enlace) {
      const after = await incrementRecoveryUsage(telegramId, tipoFicha);
      texto += `\n\n<i>Cupo ${tipoFicha === 'enlace_roto' ? 'enlace roto' : 'recuperación'}: ${after.usadoHoy}/${after.maxHoy} hoy.</i>`;
    } else if (!esVip) {
      await consumirConsultaInventarioIA(telegramId, false);
      texto += `\n\n<i>🔒 Enlace solo en VIP. Prueba gratuita: ficha sin link.</i>`;
    }

    pushAssistant(telegramId, texto);
    return { ok: true, text: texto };
  }

  // Consejo verbal (sin BD / sin ficha)
  const ctx = await filterContext(telegramId);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_BASE },
    { role: 'system', content: systemAccess(esVip, false) },
    { role: 'system', content: ctx },
    {
      role: 'system',
      content:
        'Este mensaje es SOLO consejo. NO inventes lotes ni URLs. Si el usuario quiere un anuncio concreto, dile que pida el link / recuperar subasta.',
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw new Error('AbortError');
    try {
      const completion = await client.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          temperature: 0.4,
          max_tokens: 550,
          messages,
        },
        { signal }
      );

      const raw =
        completion.choices[0]?.message?.content?.trim() ||
        '¿En qué puedo ayudarte con las subastas de vehículos embargados?';
      const answer = stripLinksForAdvice(toTelegramHtml(raw));
      pushAssistant(telegramId, answer);
      return { ok: true, text: answer + cupoNote };
    } catch (error) {
      if (signal.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      const retry = attempt < maxAttempts && isTransientAiError(error);
      logger.error('Error del asesor IA', { error: msg, attempt, retry });
      if (retry) {
        await sleep(400 * attempt);
        continue;
      }
      throw error;
    }
  }

  throw new Error('AI exhausted retries');
}

type LoteFicha = {
  titulo: string;
  marca: string;
  modelo: string;
  puja: number;
  ccaa: string | null;
  portal: string;
  cierra: Date | null;
  enlace: string;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function componerFichaLote(lote: LoteFicha, incluirEnlace: boolean): string {
  const lineas = [
    `He encontrado una subasta que encaja con lo que pediste:`,
    ``,
    `🚗 <b>${escapeHtml(lote.titulo || `${lote.marca} ${lote.modelo}`)}</b>`,
    ``,
    `💰 Puja desde: <b>${formatearPrecio(lote.puja)}</b>`,
  ];
  if (lote.ccaa) lineas.push(`📍 ${escapeHtml(lote.ccaa)}`);
  if (lote.portal) lineas.push(`🏷️ ${escapeHtml(portalDisplayName(lote.portal, lote.enlace))}`);
  if (lote.cierra) {
    lineas.push(`🕒 Cierra: ${lote.cierra.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  }
  lineas.push(``);
  if (incluirEnlace && lote.enlace) {
    const href = lote.enlace.replace(/"/g, '&quot;');
    lineas.push(`👉 <a href="${href}"><b>Subasta encontrada</b></a>`);
  } else {
    lineas.push(`🔒 <i>Enlace disponible solo en VIP. Hazte VIP para abrir la subasta.</i>`);
  }
  return lineas.join('\n');
}

async function buscarLoteEnBd(telegramId: string, userText: string): Promise<LoteFicha | null> {
  const f = await getFiltrosUsuario(telegramId);
  let brand = f.marcaNorm?.toLowerCase();
  let model = f.modeloNorm?.toLowerCase();

  const brands = await listBrandsFromInventory();
  const hit = brands.find(
    (b) =>
      userText.toLowerCase().includes(b.label.toLowerCase()) ||
      userText.toLowerCase().includes(b.brandNorm)
  );
  if (hit) {
    if (brand && hit.brandNorm !== brand) model = undefined;
    brand = hit.brandNorm;
  }
  if (model) {
    const modelToken = model.split(/\s+/)[0] ?? model;
    if (modelToken && !userText.toLowerCase().includes(modelToken)) {
      model = undefined;
    }
  }

  const pujaMatch = userText.match(/(?:menos de|hasta|bajo|max\.?|máx\.?|puja\s*(?:máxima|max)?)\s*(\d{2,6})\s*€?/i);
  const pujaMax = pujaMatch ? parseInt(pujaMatch[1]!, 10) : f.puja_maxima ?? undefined;

  const where: Record<string, unknown> = {
    OR: [{ fecha_fin: null }, { fecha_fin: { gt: new Date() } }],
  };
  if (brand) where['marcaNorm'] = brand;
  if (model) where['modeloNorm'] = model;
  if (pujaMax != null && pujaMax > 0) {
    where['puja_minima'] = { lte: pujaMax };
  }

  // CCAA desde texto (flexible: typos/guiones) o radar si solo hay una
  const ccaaFromText = resolveCcaaNormFromText(userText);
  const ccaaFilter = ccaaFromText ?? (f.ccaaNorms?.length === 1 ? f.ccaaNorms[0] : undefined);
  if (ccaaFilter) {
    where['ccaaNorm'] = ccaaFilter;
  }

  const rows = await prisma.vehiculo.findMany({
    where,
    orderBy: { fecha_fin: 'asc' },
    take: 12,
    select: {
      titulo: true,
      marca: true,
      modelo: true,
      puja_minima: true,
      comunidad_autonoma: true,
      portal: true,
      fecha_fin: true,
      enlace: true,
    },
  });

  const row = rows[0];
  if (!row?.enlace) return null;

  return {
    titulo: row.titulo,
    marca: row.marca,
    modelo: row.modelo,
    puja: row.puja_minima,
    ccaa: row.comunidad_autonoma,
    portal: row.portal,
    cierra: row.fecha_fin,
    enlace: row.enlace,
  };
}

/** Quita URLs en respuestas de consejo (la app no debe filtrar links inventados). */
function stripLinksForAdvice(raw: string): string {
  let t = raw;
  t = t.replace(/<a\s+href="[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '');
  t = t.replace(/https?:\/\/[^\s<>\]]+/gi, '');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/** Convierte Markdown residual y unifica enlaces al estilo del resumen VIP. */
export function toTelegramHtml(raw: string): string {
  let t = raw.trim();
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/__([^_]+)__/g, '<b>$1</b>');
  t = t.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, _label, url: string) =>
    auctionLinkHtml(String(url).replace(/[.,;:!?)]+$/, ''))
  );
  t = t.replace(/<a\s+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<\/a>/gi, (_m, url: string) =>
    auctionLinkHtml(url)
  );
  t = t.replace(/(?<!href=")(https?:\/\/[^\s<>\]]+)/g, (url) => {
    const clean = url.replace(/[.,;:!?)]+$/, '');
    const trailing = url.slice(clean.length);
    return auctionLinkHtml(clean) + trailing;
  });
  t = t.replace(/([^\n])\n(\d+\.\s)/g, '$1\n\n$2');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t;
}

function portalLabelFromUrl(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('escrapalia')) return 'Escrapalia';
  if (u.includes('eactivos') || u.includes('e-activos')) return 'eActivos';
  if (u.includes('subastas.boe') || u.includes('boe.es')) return 'BOE';
  if (u.includes('procurador')) return 'Procuradores';
  return 'portal';
}

function portalDisplayName(portal?: string | null, url?: string): string {
  const raw = (portal ?? '').trim();
  if (/escrapalia/i.test(raw)) return 'Escrapalia';
  if (/eactivos|e-activos/i.test(raw)) return 'eActivos';
  if (/^boe$/i.test(raw) || /boletin|boletín/i.test(raw)) return 'BOE';
  if (/procurador/i.test(raw)) return 'Procuradores';
  if (raw) return raw;
  return portalLabelFromUrl(url ?? '');
}

export function auctionLinkHtml(url: string, portal?: string | null): string {
  const href = url.trim();
  const label = portalDisplayName(portal, href);
  return `🔗 <a href="${href}">Ver subasta (${label})</a>`;
}

/** Agrupa tokens de versión en etiquetas cortas para el menú */
export async function groupSpecLabels(tokens: string[]): Promise<string[]> {
  if (tokens.length <= 12) return tokens;
  const client = getClient();
  if (!client) return tokens.slice(0, 20);

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content:
            'Agrupa tokens de versiones de coches en como máximo 12 etiquetas cortas en castellano (1-3 palabras). Responde SOLO un JSON array de strings.',
        },
        { role: 'user', content: JSON.stringify(tokens.slice(0, 40)) },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? '[]';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (Array.isArray(parsed)) return parsed.map(String).slice(0, 12);
  } catch {
    /* fallthrough */
  }
  return tokens.slice(0, 12);
}

export function clearAiHistory(telegramId: string): void {
  histories.delete(telegramId);
}
