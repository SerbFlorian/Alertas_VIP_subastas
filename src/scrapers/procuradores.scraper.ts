import type { Vehiculo, ScrapingTask, ScrapingResult } from '../types';
import { BaseScraper } from './base.scraper';
import { logger } from '../services/logger';
import { existeVehiculo, existeVehiculoPorEnlace } from '../db/queries';

// ============================================================
// PROCURADORES SCRAPER (Portal Oficial de Procuradores)
// https://www.subastasprocuradores.com
// ============================================================

export class ProcuradoresScraper extends BaseScraper {
  constructor() {
    super();
  }

  protected parse(html: string, task: ScrapingTask): Vehiculo[] {
    return [];
  }

  public async scrape(task: ScrapingTask): Promise<ScrapingResult> {
    const vehiculos: Vehiculo[] = [];
    let errorMsg: string | undefined;
    const pageStart = Number(task.extraData?.['pageStart'] ?? 1);
    const pageEnd = Number(task.extraData?.['pageEnd'] ?? 5);
    let lastPageWithResults = pageStart - 1;
    let reachedEnd = false;

    try {
      logger.info(`🔍 [Procuradores] Obteniendo listado principal con Axios...`);
      const axios = require('axios');
      const cheerio = require('cheerio');
      
      for (let page = pageStart; page <= pageEnd; page++) {
        logger.info(`🔍 [Procuradores] Página ${page} (ventana ${pageStart}–${pageEnd})...`);
        const pageUrl = `${task.url}&Page=${page}`;
        const response = await axios.get(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const items = $('.sp_box_shadow');
        if (items.length === 0) {
          reachedEnd = true;
          break;
        }
        lastPageWithResults = page;

        // 1. Extraer listado inicial
        items.each((_i: number, el: any) => {
          try {
            const row = $(el);
            const titleLink = row.find('.sp_sales__title a');
            if (!titleLink.length) return;

            const tituloRaw = titleLink.text().trim();
            const href = titleLink.attr('href') || '';
            const id_subasta = href.split('/').pop()?.split('?')[0] || `PROC-${Math.random()}`;
            const enlace = href ? `https://www.subastasprocuradores.com${href}` : task.url;

            const tasacionRaw = row.find('.sp_sales__appraisal').text().replace(/[^0-9,]/g, '').replace(',', '.');
            const pujaMinRaw = row.find('.sp_sales__bid').text().replace(/[^0-9,]/g, '').replace(',', '.');
            const ubicacion = row.find('.sp_sales__location').text().trim().replace(/\s+/g, ' ');
            
            const marca = tituloRaw.split(' ')[0] || 'Desconocida';
            const modelo = tituloRaw.split(' ').slice(1, 3).join(' ') || 'Desconocido';

            // Intentar coger fecha de la lista principal
            const fechaRawAttr = row.find('[data-bidenddate]').attr('data-bidenddate');
            let fechaFinIso: string | null = null;
            
            if (fechaRawAttr) {
              const dateObj = new Date(fechaRawAttr);
              if (!isNaN(dateObj.getTime())) {
                fechaFinIso = dateObj.toISOString();
              }
            }

            vehiculos.push({
              id_subasta,
              id_lote: id_subasta,
              portal: 'Procuradores',
              enlace,
              titulo: tituloRaw,
              marca,
              modelo,
              puja_minima: parseFloat(pujaMinRaw) || 0,
              provincia: ubicacion,
              fecha_inicio: new Date().toISOString(),
              fecha_fin: fechaFinIso,
            });
          } catch (e) {
            logger.warn(`⚠️ [Procuradores] Error parseando vehículo en lista: ${(e as Error).message}`);
          }
        });
      }

      // Deep scrape solo para anuncios NUEVOS sin fecha (no re-visitar BD)
      for (const v of vehiculos) {
        if (v.fecha_fin) continue;
        const yaEnBd =
          (await existeVehiculoPorEnlace(v.enlace)) ||
          (await existeVehiculo(v.id_subasta, 'Procuradores'));
        if (yaEnBd) {
          logger.info(`⏭️ [Procuradores] Skip detalle (ya en BD): ${v.id_subasta}`);
          continue;
        }
        try {
          logger.info(`🔍 [Procuradores] Deep Scraping para fecha: ${v.id_subasta}`);
          const detRes = await axios.get(v.enlace, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            },
            timeout: 10000
          });
          const $det = cheerio.load(detRes.data);
          
          // Buscar la etiqueta data-bidenddate en la página de detalle
          const dateAttr = $det('[data-bidenddate]').attr('data-bidenddate');
          if (dateAttr) {
            const dateObj = new Date(dateAttr);
            if (!isNaN(dateObj.getTime())) {
              v.fecha_fin = dateObj.toISOString();
              logger.info(`✅ [Procuradores] Fecha recuperada: ${v.fecha_fin}`);
            }
          } else {
            logger.info(`⚠️ [Procuradores] Fecha no encontrada en detalle de ${v.id_subasta}`);
          }
        } catch (e) {
          logger.warn(`❌ [Procuradores] Falló Deep Scraping en ${v.id_subasta}: ${(e as Error).message}`);
        }
        // Pequeña pausa para no saturar al servidor
        await new Promise(r => setTimeout(r, 1000));
      }

    } catch (error) {
      errorMsg = (error as Error).message;
      logger.error(`❌ [Procuradores] Error principal: ${errorMsg}`);
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
      error: errorMsg
    };
  }
}
