import axios, { type AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import type { Vehiculo, ScrapingTask, ScrapingResult, ScraperOptions } from '../types';
import { logger } from '../services/logger';
import { existeVehiculoPorEnlace } from '../db/queries';

// ============================================================
// BASE SCRAPER — HTTP directo (Axios). Sin Bright Data / proxy.
// ============================================================

export abstract class BaseScraper {
  protected readonly options: ScraperOptions;
  private readonly httpClient: AxiosInstance;

  private static readonly USER_AGENTS: readonly string[] = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  ];

  private static readonly ANTI_BOT_HEADERS: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  };

  constructor(options?: Partial<ScraperOptions>) {
    this.options = {
      maxRetries: parseInt(process.env['MAX_RETRIES'] ?? '3', 10),
      requestDelayMs: parseInt(process.env['REQUEST_DELAY_MS'] ?? '2000', 10),
      ...options,
    };

    this.httpClient = axios.create({ timeout: 60_000 });
  }

  protected abstract parse(html: string, task: ScrapingTask): Vehiculo[];

  async scrape(task: ScrapingTask): Promise<ScrapingResult> {
    const startTime = Date.now();

    try {
      if (await existeVehiculoPorEnlace(task.url)) {
        logger.info(`⏭️ [${task.portal}] Saltando URL, ya existe en BD: ${task.url}`);
        return { task, vehiculos: [], totalEncontrados: 0, paginasEscaneadas: 0 };
      }

      logger.info(`🔍 [${task.portal}] ${task.url} — Iniciando scraping (1 intento)`);

      const html = await this.fetchHTML(task.url);
      const errorDetectado = this.detectarBloqueo(html);

      if (errorDetectado) {
        throw new Error(`Bloqueo detectado: ${errorDetectado}`);
      }

      const vehiculos = this.parse(html, task);

      logger.info(`✅ [${task.portal}] ${vehiculos.length} vehículos extraídos (${Date.now() - startTime}ms)`);

      return {
        task,
        vehiculos,
        totalEncontrados: vehiculos.length,
        paginasEscaneadas: 1,
      };
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      logger.warn(`⚠️ [${task.portal}] Error en scraping: ${mensaje}`);

      return { task, vehiculos: [], totalEncontrados: 0, paginasEscaneadas: 0, error: mensaje };
    }
  }

  protected async fetchHTML(url: string): Promise<string> {
    return this.fetchDirect(url, 'GET');
  }

  protected async postHTML(url: string, data: Record<string, string>): Promise<string> {
    return this.fetchDirect(url, 'POST', data);
  }

  private async fetchDirect(url: string, method: string = 'GET', data?: Record<string, string>): Promise<string> {
    const response = await this.httpClient.request<string>({
      url,
      method,
      data: method === 'POST' && data ? new URLSearchParams(data).toString() : undefined,
      headers: {
        'User-Agent': this.getRandomUserAgent(),
        ...BaseScraper.ANTI_BOT_HEADERS,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      responseType: 'text',
    });
    return response.data;
  }

  private getRandomUserAgent(): string {
    return BaseScraper.USER_AGENTS[Math.floor(Math.random() * BaseScraper.USER_AGENTS.length)]!;
  }

  private detectarBloqueo(html: string): string | null {
    const htmlLower = html.toLowerCase();
    if (html.includes('Access Denied') && html.trim().length < 2000) return 'Acceso denegado';
    if (html.includes('cf-challenge') || html.includes('cf-browser-verification')) return 'Cloudflare challenge';
    if (htmlLower.includes('datadome') || htmlLower.includes('px-captcha')) return 'Captcha Datadome/PerimeterX';
    if (htmlLower.includes('verify you are human')) return 'Verificación humana';
    if (html.trim().length < 500) return 'HTML demasiado corto';
    return null;
  }

  protected loadHTML(html: string): cheerio.CheerioAPI {
    return cheerio.load(html);
  }

  protected parsearPrecio(textoPrecio: string): number {
    if (!textoPrecio) return 0;
    const limpio = textoPrecio.replace(/[^\d.,\-]/g, '').trim();
    if (!limpio) return 0;
    const normalizado = limpio.replace(/\./g, '').replace(',', '.');
    const numero = parseFloat(normalizado);
    return isNaN(numero) ? 0 : numero;
  }

  protected limpiarTexto(texto: string): string {
    return texto.replace(/\s+/g, ' ').trim();
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
