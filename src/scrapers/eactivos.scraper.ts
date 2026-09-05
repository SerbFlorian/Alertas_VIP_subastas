import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Vehiculo, ScrapingTask, ScrapingResult } from '../types';
import { BaseScraper } from './base.scraper';
import { logger } from '../services/logger';
import { existeVehiculo, existeVehiculoPorEnlace } from '../db/queries';

// ============================================================
// EACTIVOS SCRAPER
// Listado AJAX: /listado-de-liquidaciones/obtener?page=N&asset_type[]=3
// (la UI de vehículos no tiene botón "Siguiente"; pagina por XHR)
// ============================================================

const LIST_URL = 'https://www.eactivos.com/listado-de-liquidaciones/obtener';
const ASSET_TYPE_VEHICULOS = 3;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TITLE_PREFIXES = [
  'Subasta de vehículo marca',
  'Subasta de vehículo',
  'Subasta de ciclomotor',
  'Subasta de motocicleta',
  'Vehículo',
  'Motocicleta',
  'Ciclomotor',
  'Remolque',
  'Furgoneta',
  'Camión',
  'Lote de',
] as const;

function parseEuroAmount(raw: string | undefined | null): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function cleanTitle(tituloRaw: string): { marca: string; modelo: string } {
  let clean = tituloRaw;
  for (const prefix of TITLE_PREFIXES) {
    const regex = new RegExp(`^${prefix}\\s*`, 'i');
    if (regex.test(clean)) {
      clean = clean.replace(regex, '');
      break;
    }
  }
  clean = clean.replace(/^marca\s+/i, '');
  // Quitar ubicación del título: "… en Motril (Granada)"
  clean = clean.replace(/\s+en\s+.+$/i, '');
  const words = clean.split(/\s+/).filter(Boolean);
  return {
    marca: words[0] || 'Desconocida',
    modelo: words.slice(1, 3).join(' ') || 'Desconocido',
  };
}

function parseFechaFin($el: cheerio.Cheerio<any>): string | null {
  const dataEndDate = $el.find('[data-end-date]').attr('data-end-date')
    || $el.attr('data-end-date');
  if (dataEndDate) {
    const isoString = dataEndDate.includes('T')
      ? dataEndDate
      : `${dataEndDate.replace(' ', 'T')}Z`;
    const dateObj = new Date(isoString);
    if (!isNaN(dateObj.getTime())) return dateObj.toISOString();
  }

  const badge = $el.find('.end-date').text().replace(/\s+/g, ' ').trim();
  const m = badge.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const dateObj = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00.000Z`);
    if (!isNaN(dateObj.getTime())) return dateObj.toISOString();
  }
  return null;
}

function parsePuja($el: cheerio.Cheerio<any>): number {
  const bidElement = $el.find('.current-bid-amount');
  const dataVal = bidElement.attr('data-value');
  const initialVal = bidElement.attr('data-initial-price');
  if (dataVal && parseFloat(dataVal) > 0) return parseFloat(dataVal);
  if (initialVal && parseFloat(initialVal) > 0) return parseFloat(initialVal);

  const textVal = parseEuroAmount(bidElement.text());
  if (textVal > 0) return textVal;

  // Precio de salida / valoración cuando aún no hay pujas
  const valoracion = parseEuroAmount($el.find('.liquidation-price').first().text());
  return valoracion > 0 ? valoracion : 0;
}

function parseCard($: cheerio.CheerioAPI, el: any): Vehiculo | null {
  const $el = $(el);
  const id_subasta = $el.attr('data-liquidation');
  if (!id_subasta) return null;

  const href = $el.find('a.img-link').attr('href') || $el.find('.card-title a').attr('href');
  if (!href) return null;

  const tituloRaw = $el.find('.card-title a').text().trim().replace(/\s+/g, ' ');
  if (!tituloRaw || tituloRaw.length < 5) return null;

  const enlace = href.startsWith('http') ? href : `https://www.eactivos.com${href}`;
  const { marca, modelo } = cleanTitle(tituloRaw);

  const locationText = $el.find('.card-subtitle').text().trim().replace(/\s+/g, ' ');
  let provincia = 'España';
  if (locationText.includes(',')) {
    provincia = locationText.split(',').pop()?.trim() || 'España';
  } else if (locationText) {
    provincia = locationText;
  }

  return {
    id_subasta,
    id_lote: id_subasta,
    portal: 'eActivos',
    enlace,
    titulo: tituloRaw,
    marca,
    modelo,
    puja_minima: parsePuja($el),
    provincia,
    fecha_inicio: new Date().toISOString(),
    fecha_fin: parseFechaFin($el),
  };
}

export class EactivosScraper extends BaseScraper {
  constructor() {
    super();
  }

  protected parse(_html: string, _task: ScrapingTask): Vehiculo[] {
    return [];
  }

  public async scrape(task: ScrapingTask): Promise<ScrapingResult> {
    const vehiculos: Vehiculo[] = [];
    let errorMsg: string | undefined;
    const pageStart = Number(task.extraData?.['pageStart'] ?? 1);
    const pageEnd = Number(task.extraData?.['pageEnd'] ?? pageStart + 19);
    let pageIndex = pageStart;
    let lastPageWithResults = pageStart - 1;
    let reachedEnd = false;

    try {
      let hasMore = true;

      while (hasMore && pageIndex <= pageEnd) {
        logger.info(`🔍 [eActivos] API página ${pageIndex} (ventana ${pageStart}–${pageEnd})...`);

        const response = await axios.get(LIST_URL, {
          params: {
            page: pageIndex,
            'asset_type[]': ASSET_TYPE_VEHICULOS,
          },
          headers: {
            Accept: 'text/html, */*; q=0.01',
            'User-Agent': USER_AGENT,
            'X-Requested-With': 'XMLHttpRequest',
            Referer: 'https://www.eactivos.com/listado-de-vehiculos',
          },
          timeout: 30000,
        });

        const html = String(response.data ?? '');
        const $ = cheerio.load(html);
        const cards = $('.liquidation-card[data-liquidation]').toArray();

        if (
          cards.length === 0 ||
          /No hay liquidaciones disponibles/i.test($.text())
        ) {
          logger.info(`ℹ️ [eActivos] Fin de catálogo en página ${pageIndex} (0 anuncios reales).`);
          hasMore = false;
          reachedEnd = true;
          break;
        }

        lastPageWithResults = pageIndex;
        let parseados = 0;

        for (const el of cards) {
          try {
            const v = parseCard($, el);
            if (!v) continue;
            vehiculos.push(v);
            parseados++;
          } catch (e) {
            logger.warn(`⚠️ [eActivos] Error parseando card: ${(e as Error).message}`);
          }
        }

        logger.info(`📍 [eActivos] Página ${pageIndex}: ${parseados} anuncios de ${cards.length} cards.`);

        pageIndex++;
        if (pageIndex <= pageEnd) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }

      if (pageIndex > pageEnd && !reachedEnd) {
        reachedEnd = false;
      }

      // Deduplicar por id de liquidación
      const unicos = new Map<string, Vehiculo>();
      for (const v of vehiculos) unicos.set(v.id_subasta, v);
      vehiculos.splice(0, vehiculos.length, ...Array.from(unicos.values()));

      // Enriquecer / deep scrape solo anuncios NUEVOS (evitar re-visitar BD)
      const pendientes: Vehiculo[] = [];
      for (const v of vehiculos) {
        const yaEnBd =
          (await existeVehiculo(v.id_subasta, 'eActivos')) ||
          (await existeVehiculoPorEnlace(v.enlace));
        if (yaEnBd) {
          continue;
        }
        pendientes.push(v);
      }
      if (pendientes.length < vehiculos.length) {
        logger.info(
          `⏭️ [eActivos] Skip detalle/puja: ${vehiculos.length - pendientes.length} ya en BD · ${pendientes.length} nuevos a enriquecer`
        );
      }

      const sinPuja = pendientes.filter((v) => !v.puja_minima || v.puja_minima <= 0);
      for (const v of sinPuja.slice(0, 30)) {
        try {
          const bidRes = await axios.get(
            `https://www.eactivos.com/liquidacion/${v.id_subasta}/mejor-puja`,
            {
              headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
              timeout: 8000,
            }
          );
          const amount = Number(bidRes.data?.amount ?? 0);
          if (amount > 0) v.puja_minima = amount;
        } catch {
          // ignore
        }
      }

      for (const v of pendientes) {
        if (v.fecha_fin) continue;
        try {
          logger.info(`🔍 [eActivos] Deep scrape fecha: ${v.id_subasta}`);
          const detRes = await axios.get(v.enlace, {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 10000,
          });
          const $d = cheerio.load(detRes.data);
          const locText = $d('.liquidation-location').text().trim().replace(/\s+/g, ' ');
          if (locText) v.provincia = locText;

          const dataEnd = $d('[data-end-date]').attr('data-end-date');
          if (dataEnd) {
            const dObj = new Date(dataEnd.includes('T') ? dataEnd : `${dataEnd.replace(' ', 'T')}Z`);
            if (!isNaN(dObj.getTime())) {
              v.fecha_fin = dObj.toISOString();
              continue;
            }
          }

          const bodyText = $d('body').text();
          const dateMatch = bodyText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (dateMatch) {
            const timeMatch = bodyText.match(/(\d{2}):(\d{2})/);
            const finalTime = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : '12:00';
            const dObj = new Date(
              `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}T${finalTime}:00.000Z`
            );
            if (!isNaN(dObj.getTime())) v.fecha_fin = dObj.toISOString();
          }
        } catch (err) {
          logger.warn(
            `⚠️ [eActivos] Deep scrape falló para ${v.id_subasta}: ${(err as Error).message}`
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      errorMsg = (err as Error).message;
      logger.error(`❌ Error en eActivos: ${errorMsg}`);
    }

    return {
      task: {
        ...task,
        extraData: {
          ...(task.extraData ?? {}),
          lastPageWithResults,
          reachedEnd,
        },
      },
      vehiculos,
      totalEncontrados: vehiculos.length,
      paginasEscaneadas: Math.max(0, lastPageWithResults - pageStart + 1),
      error: errorMsg,
    };
  }
}
