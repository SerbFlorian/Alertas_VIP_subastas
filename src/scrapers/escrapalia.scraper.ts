import axios from 'axios';
import type { Vehiculo, ScrapingTask, ScrapingResult } from '../types';
import { BaseScraper } from './base.scraper';
import { logger } from '../services/logger';

// ============================================================
// ESCRAPALIA SCRAPER (API directa)
// https://www.escrapalia.com
// Paginación real: skip + pageSize (pageIndex NO avanza el cursor)
// ============================================================

const PAGE_SIZE = 100;
const API_BASE = 'https://api.escrapalia.com/api/web/batch';

export class EscrapaliaScraper extends BaseScraper {
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
    const pageEnd = Number(task.extraData?.['pageEnd'] ?? pageStart + 9);
    let pageIndex = pageStart;
    let lastPageWithResults = pageStart - 1;
    let reachedEnd = false;

    try {
      let hasMore = true;

      while (hasMore && pageIndex <= pageEnd) {
        const skip = (pageIndex - 1) * PAGE_SIZE;
        logger.info(
          `🔍 [Escrapalia] API página ${pageIndex} skip=${skip} (ventana ${pageStart}–${pageEnd})...`
        );

        const response = await axios.get(API_BASE, {
          params: {
            categoryPath: 'vehiculos/vehiculos-y-componentes',
            country: 'España',
            isFinished: false,
            language: 'es',
            skip,
            pageSize: PAGE_SIZE,
          },
          headers: {
            Accept: 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          },
          timeout: 20000,
        });

        const items = response.data?.data;
        const total = Number(response.data?.count ?? 0);

        if (!Array.isArray(items) || items.length === 0) {
          hasMore = false;
          reachedEnd = true;
          break;
        }

        lastPageWithResults = pageIndex;

        for (const item of items) {
          // eventId = subasta; id = lote (varios lotes pueden compartir eventId)
          const id_subasta = String(item.eventId || item.batchReference || item.id);
          const id_lote = String(item.id);
          const titulo = item.name || 'Vehículo sin título';
          const words = String(titulo).split(/\s+/).filter(Boolean);
          const marca = words[0] || 'Desconocida';
          const modelo = words.slice(1, 3).join(' ') || 'Desconocido';
          const puja_minima = Number(item.nextBid || item.lastBid || 0) || 0;
          const provincia = item.location?.province || '';
          const fecha_inicio = item.startDate || new Date().toISOString();
          const fecha_fin = item.endDate || new Date().toISOString();
          const categorySlug = item.categoryHash
            ? String(item.categoryHash).split('-20')[0]
            : 'vehiculos';
          const enlace = item.hash
            ? `https://www.escrapalia.com/es/lote/${categorySlug}/${item.hash}`
            : task.url;

          vehiculos.push({
            id_subasta,
            id_lote,
            portal: 'Escrapalia',
            enlace,
            titulo,
            marca,
            modelo,
            puja_minima,
            provincia,
            fecha_inicio,
            fecha_fin,
          });
        }

        logger.info(
          `📍 [Escrapalia] skip=${skip}: ${items.length} lotes (total API=${total || '?'}).`
        );

        const fetched = skip + items.length;
        if ((total > 0 && fetched >= total) || items.length < PAGE_SIZE) {
          hasMore = false;
          reachedEnd = true;
        } else {
          pageIndex++;
        }
      }

      if (pageIndex > pageEnd && !reachedEnd) {
        reachedEnd = false;
      }
    } catch (err) {
      errorMsg = (err as Error).message;
      logger.error(`❌ Error en Escrapalia API: ${errorMsg}`);
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
