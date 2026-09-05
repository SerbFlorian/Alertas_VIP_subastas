import axios from 'axios';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright-core';
import type { Vehiculo, ScrapingResult } from '../types';
import { logger } from '../services/logger';

import { existeVehiculo } from '../db/queries';
// ============================================================
// BOE SCRAPER — Portal de Subastas Electrónicas del Estado
// https://subastas.boe.es
//
// Este scraper NO necesita Bright Data ni proxies.
// El portal del BOE es un sitio gubernamental sin protección
// anti-bot (sin Cloudflare, DataDome ni captchas).
// Coste de scraping: 0€
// ============================================================

const BOE_BASE_URL = 'https://subastas.boe.es';

// URL de búsqueda de subastas de vehículos en estado "Celebrándose"
const BOE_SEARCH_URL = `${BOE_BASE_URL}/subastas_ava.php`;

// Headers para simular un navegador normal
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

// ------------------------------------------------------------
// Función principal: Escanear subastas de vehículos
// ------------------------------------------------------------

/**
 * Escanea el portal de subastas del BOE buscando vehículos embargados.
 * Primero obtiene la lista de resultados, luego extrae los detalles de cada subasta.
 *
 * @param maxPaginas - Número máximo de páginas a escanear (default: 2)
 * @param delayMs - Delay entre peticiones para ser respetuosos con el servidor (default: 3000)
 */
export async function scrapearSubastasBOE(
  maxPaginas: number = 2,
  delayMs: number = 3000,
  pageStart: number = 1
): Promise<ScrapingResult> {
  const vehiculosTotal: Vehiculo[] = [];
  let paginasEscaneadas = 0;
  let lastPageWithResults = pageStart - 1;
  let reachedEnd = false;
  const pageEnd = pageStart + maxPaginas - 1;

  try {
    logger.info(`🔍 Scraping BOE ventana ${pageStart}–${pageEnd} (delay ${delayMs}ms)...`);

    // Paso 1: Hacer la búsqueda inicial para obtener el listado
    const primeraRespuesta = await hacerBusquedaInicial();

    if (!primeraRespuesta) {
      return {
        task: { portal: 'BOE', url: BOE_SEARCH_URL, extraData: { lastPageWithResults: 0, reachedEnd: true } },
        vehiculos: [],
        totalEncontrados: 0,
        paginasEscaneadas: 0,
        error: 'No se pudo acceder al BOE',
      };
    }

    // Paso 2: Extraer IDs de subastas del listado de resultados
    const { idsSubastas, totalResultados, idBusqueda } = extraerListado(primeraRespuesta);
    paginasEscaneadas = 1;

    // If window starts after 1, skip collecting page-1 IDs unless start===1
    const collectedIds: string[] = pageStart === 1 ? [...idsSubastas] : [];
    if (pageStart === 1 && idsSubastas.length) lastPageWithResults = 1;

    // Paso 2.5: Filtrar IDs que ya existen en la BD para optimizar
    if (pageStart === 1) {
      const booleanArray = await Promise.all(idsSubastas.map(id => existeVehiculo(id, 'BOE')));
      const nuevosIdSubastas = idsSubastas.filter((_, index) => !booleanArray[index]);
      logger.info(`📋 BOE: ${totalResultados} activas. ${nuevosIdSubastas.length} nuevas en pág.1.`);
    }

    // Paso 3: Paginación dentro de la ventana
    if (idBusqueda) {
      const from = Math.max(2, pageStart);
      for (let pagina = from; pagina <= pageEnd; pagina++) {
        await delay(delayMs);
        const htmlPagina = await obtenerPagina(idBusqueda, pagina);
        if (!htmlPagina) {
          reachedEnd = true;
          break;
        }

        const { idsSubastas: masIds } = extraerListado(htmlPagina);
        if (masIds.length === 0) {
          reachedEnd = true;
          break;
        }

        collectedIds.push(...masIds);
        paginasEscaneadas++;
        lastPageWithResults = pagina;
        logger.info(`📄 BOE página ${pagina}: ${masIds.length} subastas.`);
      }
      if (lastPageWithResults < pageEnd && !reachedEnd) {
        // incomplete window → treat as end if we never got pages
      }
    }

    const existencias = await Promise.all(collectedIds.map(id => existeVehiculo(id, 'BOE')));
    const idsAProcesar = collectedIds.filter((_, idx) => !existencias[idx]);

    logger.info(`🚗 BOE detalles: ${idsAProcesar.length} nuevas (de ${collectedIds.length} en ventana)...`);

    for (const idSub of idsAProcesar) {
      await delay(delayMs);
      try {
        const vehiculos = await obtenerDetalleSubasta(idSub);
        for (const v of vehiculos) {
          vehiculosTotal.push(v);
        }
      } catch (error) {
        logger.warn(`⚠️ Error detalle BOE ${idSub}: ${(error as Error).message}`);
      }
    }

    logger.info(`✅ BOE: ${vehiculosTotal.length} vehículos de ${paginasEscaneadas} páginas.`);

    return {
      task: {
        portal: 'BOE',
        url: BOE_SEARCH_URL,
        extraData: { lastPageWithResults, reachedEnd: reachedEnd || lastPageWithResults < pageEnd },
      },
      vehiculos: vehiculosTotal,
      totalEncontrados: totalResultados,
      paginasEscaneadas,
    };
  } catch (error) {
    const msg = (error as Error).message;
    logger.error(`❌ Error fatal en scraper del BOE: ${msg}`);
    return {
      task: {
        portal: 'BOE',
        url: BOE_SEARCH_URL,
        extraData: { lastPageWithResults, reachedEnd: true },
      },
      vehiculos: vehiculosTotal,
      totalEncontrados: vehiculosTotal.length,
      paginasEscaneadas,
      error: msg,
    };
  }
}

// ------------------------------------------------------------
// Paso 1: Búsqueda inicial (POST al formulario de búsqueda)
// ------------------------------------------------------------

let globalBoeCookies = '';

async function hacerBusquedaInicial(): Promise<string | null> {
  let browser;
  try {
    logger.info(`🔍 [BOE] Abriendo navegador interactivo local (Playwright Chromium)...`);
    browser = await chromium.launch({
      executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] || undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    
    await page.goto(BOE_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Rellenar formulario de búsqueda
    await page.click('input#idTipoBienV', { force: true }); // Vehículos
    await page.click('input#idEstadoEJ', { force: true }); // En ejecución
    
    // Enviar formulario
    await page.click('input[value="Buscar"]');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const html = await page.content();
    
    // Guardar cookies para futuras peticiones de paginación y detalle
    const cookies = await context.cookies();
    globalBoeCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();
    return html;
  } catch (error) {
    logger.error(`❌ Error en búsqueda inicial del BOE con Playwright: ${(error as Error).message}`);
    if (browser) await browser.close();
    return null;
  }
}

// ------------------------------------------------------------
// Paso 2: Extraer IDs de subastas del HTML de resultados
// ------------------------------------------------------------

interface ListadoResult {
  idsSubastas: string[];
  totalResultados: number;
  idBusqueda: string | null;
}

function extraerListado(html: string): ListadoResult {
  const $ = cheerio.load(html);
  const idsSubastas: string[] = [];
  let totalResultados = 0;
  let idBusqueda: string | null = null;

  // Extraer el total de resultados del texto "Se han encontrado X subastas"
  const textoTotal = $('div.resultados, p.resultados, span.resultados').text();
  const matchTotal = textoTotal.match(/(\d+)\s*subasta/i);
  if (matchTotal) {
    totalResultados = parseInt(matchTotal[1], 10);
  }

  // Extraer el id_busqueda del formulario de paginación (suele estar en un hidden field o en los links)
  const linkPaginacion = $('a[href*="id_busqueda"]').first().attr('href');
  if (linkPaginacion) {
    const matchBusqueda = linkPaginacion.match(/id_busqueda=([^&]+)/);
    if (matchBusqueda) {
      idBusqueda = matchBusqueda[1];
    }
  }

  // Extraer IDs de subastas de los enlaces del listado
  // Los enlaces de detalle tienen el formato: detalleSubasta.php?idSub=SUB-JA-2024-xxxxx
  $('a[href*="detalleSubasta"]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    const matchId = href.match(/idSub=([^&]+)/);
    if (matchId && matchId[1]) {
      const id = matchId[1];
      if (!idsSubastas.includes(id)) {
        idsSubastas.push(id);
      }
    }
  });

  // Si no encontramos links de detalle, buscar en las celdas de la tabla de resultados
  if (idsSubastas.length === 0) {
    $('td a, div.resultado-busqueda a').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      if (href.includes('idSub=') || href.includes('detalleSubasta')) {
        const matchId = href.match(/idSub=([^&]+)/);
        if (matchId && matchId[1] && !idsSubastas.includes(matchId[1])) {
          idsSubastas.push(matchId[1]);
        }
      }
    });
  }

  return { idsSubastas, totalResultados, idBusqueda };
}

// ------------------------------------------------------------
// Paso 3: Obtener HTML de las siguientes páginas
// ------------------------------------------------------------

async function obtenerPagina(idBusqueda: string, pagina: number): Promise<string | null> {
  try {
    const url = `${BOE_SEARCH_URL}?id_busqueda=${idBusqueda}&page_hits=40&sort_field[0]=SUBASTA.FECHA_FIN_YMD&sort_order[0]=asc&pag=${pagina}`;
    logger.info(`🌐 GET ${url}`);

    const response = await axios.get(url, {
      headers: { ...HEADERS, Cookie: globalBoeCookies },
      timeout: 30000,
    });

    return response.data;
  } catch (error) {
    logger.error(`❌ Error obteniendo página ${pagina} del BOE: ${(error as Error).message}`);
    return null;
  }
}

// ------------------------------------------------------------
// Paso 4: Obtener HTML del detalle de la subasta
// ------------------------------------------------------------

async function obtenerDetalleSubasta(idSubasta: string): Promise<Vehiculo[]> {
  const vehiculos: Vehiculo[] = [];

  // Obtener datos generales de la subasta (ver=1)
  const urlGeneral = `${BOE_BASE_URL}/detalleSubasta.php?idSub=${idSubasta}&ver=1`;
  const responseGeneral = await axios.get(urlGeneral, {
    headers: { ...HEADERS, Cookie: globalBoeCookies },
    timeout: 30000,
  });
  const $general = cheerio.load(responseGeneral.data);

  // Extraer datos económicos generales
  const datosGenerales = extraerDatosGenerales($general, idSubasta);

  // Obtener datos de la autoridad gestora (ver=2) para sacar la provincia exacta
  await delay(500);
  const urlGestora = `${BOE_BASE_URL}/detalleSubasta.php?idSub=${idSubasta}&ver=2`;
  const responseGestora = await axios.get(urlGestora, {
    headers: { ...HEADERS, Cookie: globalBoeCookies },
    timeout: 30000,
  });
  const $gestora = cheerio.load(responseGestora.data);
  const provinciaGestora = extraerProvinciaGestora($gestora);
  if (provinciaGestora) {
    datosGenerales.provincia = provinciaGestora;
  }

  // Obtener datos del bien / vehículo (ver=3)
  await delay(500); // Pequeño delay entre peticiones al mismo detalle
  const urlBien = `${BOE_BASE_URL}/detalleSubasta.php?idSub=${idSubasta}&ver=3`;
  const responseBien = await axios.get(urlBien, {
    headers: { ...HEADERS, Cookie: globalBoeCookies },
    timeout: 30000,
  });
  const $bien = cheerio.load(responseBien.data);

  // Extraer datos de cada lote de vehículos
  const lotes = extraerLotesVehiculos($bien, idSubasta, datosGenerales);

  if (lotes.length > 0) {
    vehiculos.push(...lotes);
  } else {
    // Si no se encontraron lotes individuales, crear uno genérico con los datos generales
    const vehiculoGenerico = crearVehiculoGenerico($general, $bien, idSubasta, datosGenerales);
    if (vehiculoGenerico) {
      vehiculos.push(vehiculoGenerico);
    }
  }

  return vehiculos;
}

// ------------------------------------------------------------
// Extracción de datos de la página de detalle
// ------------------------------------------------------------

interface DatosGenerales {
  autoridad: string;
  tipoSubasta: string;
  fechaInicio: string;
  fechaFin: string;
  valorSubasta: number;
  pujaMinima: number;
  deposito: number;
  provincia?: string;
}

function extraerDatosGenerales($: cheerio.CheerioAPI, _idSubasta: string): DatosGenerales {
  const datos: DatosGenerales = {
    autoridad: '',
    tipoSubasta: '',
    fechaInicio: '',
    fechaFin: '',
    valorSubasta: 0,
    pujaMinima: 0,
    deposito: 0,
  };

  // El BOE usa una estructura de tabla con filas de etiqueta/valor
  // Buscar en todas las filas de tabla y textos descriptivos
  $('th, dt, .etiqueta, .label-campo').each((_i, el) => {
    const etiqueta = $(el).text().trim().toLowerCase();
    const valor = $(el).next('td, dd, .valor-campo, .dato').text().trim();

    if (etiqueta.includes('autoridad') || etiqueta.includes('organismo')) {
      datos.autoridad = valor;
    } else if (etiqueta.includes('tipo de subasta') || etiqueta.includes('tipo subasta')) {
      datos.tipoSubasta = valor;
    } else if (etiqueta.includes('fecha de inicio') || etiqueta.includes('inicio')) {
      datos.fechaInicio = parsearFechaBOE(valor);
    } else if (etiqueta.includes('fecha de conclus') || etiqueta.includes('conclusión') || etiqueta.includes('fin')) {
      datos.fechaFin = parsearFechaBOE(valor);
    } else if (etiqueta.includes('valor subasta') || etiqueta.includes('valor total')) {
      datos.valorSubasta = parsearPrecioBOE(valor);
    } else if (etiqueta.includes('puja mínima') || etiqueta.includes('puja minima')) {
      datos.pujaMinima = parsearPrecioBOE(valor);
    } else if (etiqueta.includes('depósito') || etiqueta.includes('deposito')) {
      datos.deposito = parsearPrecioBOE(valor);
    }
  });

  return datos;
}

function extraerProvinciaGestora($: cheerio.CheerioAPI): string | undefined {
  let provincia: string | undefined = undefined;
  $('th, dt, .etiqueta').each((_i, el) => {
    const etiqueta = $(el).text().trim().toLowerCase();
    if (etiqueta.includes('dirección') || etiqueta.includes('direccion')) {
      const valor = $(el).next('td, dd').text().trim();
      // Ejemplo: "PZ DOCTOR LETAMENDI 13-22 ; 08071 BARCELONA"
      // La provincia suele ser lo que va después del código postal o al final
      const partes = valor.split(';');
      const ultimaParte = partes[partes.length - 1].trim();
      // Intentar extraer la palabra después del código postal o toda la frase final
      const match = ultimaParte.match(/\b\d{5}\b\s*(.+)/);
      if (match && match[1]) {
        provincia = match[1].trim();
      } else {
        provincia = ultimaParte;
      }
    }
  });
  return provincia;
}

function extraerLotesVehiculos(
  $: cheerio.CheerioAPI,
  idSubasta: string,
  datosGenerales: DatosGenerales
): Vehiculo[] {
  const vehiculos: Vehiculo[] = [];
  let loteIndex = 0;

  // El BOE muestra los lotes en secciones separadas o en una tabla
  // Buscamos secciones que contengan datos del bien
  const secciones = $('div.bloque, div.lote, fieldset, .grupo-campos').toArray();

  // Si no hay secciones claras, buscar en la tabla general de datos del bien
  if (secciones.length === 0) {
    const vehiculo = extraerVehiculoDeTabla($, idSubasta, loteIndex.toString(), datosGenerales);
    if (vehiculo) vehiculos.push(vehiculo);
    return vehiculos;
  }

  for (const seccion of secciones) {
    const $seccion = $(seccion);
    const textoSeccion = $seccion.text().toLowerCase();

    // Solo procesar secciones que parezcan contener datos de vehículos
    if (textoSeccion.includes('vehículo') || textoSeccion.includes('vehiculo') ||
        textoSeccion.includes('matrícula') || textoSeccion.includes('bastidor') ||
        textoSeccion.includes('marca') || textoSeccion.includes('modelo')) {

      const vehiculo = extraerVehiculoDeSeccion($, $seccion, idSubasta, loteIndex.toString(), datosGenerales);
      if (vehiculo) {
        vehiculos.push(vehiculo);
        loteIndex++;
      }
    }
  }

  return vehiculos;
}

function extraerVehiculoDeTabla(
  $: cheerio.CheerioAPI,
  idSubasta: string,
  idLote: string,
  datosGenerales: DatosGenerales
): Vehiculo | null {
  let titulo = '';
  let marca = '';
  let modelo = '';
  let matricula = '';
  let bastidor = '';
  let descripcion = '';
  let ubicacion = '';
  let valorTasacion = datosGenerales.valorSubasta;
  let pujaMinima = datosGenerales.pujaMinima;
  let deposito = datosGenerales.deposito;

  $('th, dt, .etiqueta, .label-campo').each((_i, el) => {
    const etiqueta = $(el).text().trim().toLowerCase();
    const valor = $(el).next('td, dd, .valor-campo, .dato').text().trim();

    if (etiqueta.includes('descripción') || etiqueta.includes('descripcion')) {
      descripcion = valor;
      if (!titulo) titulo = valor;
    } else if (etiqueta.includes('marca')) {
      marca = valor;
    } else if (etiqueta.includes('modelo')) {
      modelo = valor;
    } else if (etiqueta.includes('matrícula') || etiqueta.includes('matricula')) {
      matricula = valor;
    } else if (etiqueta.includes('bastidor') || etiqueta.includes('vin')) {
      bastidor = valor;
    } else if (etiqueta.includes('depositario') || etiqueta.includes('localización') || etiqueta.includes('situación')) {
      ubicacion = valor;
    } else if (etiqueta.includes('valor') && etiqueta.includes('tasación')) {
      valorTasacion = parsearPrecioBOE(valor) || valorTasacion;
    } else if (etiqueta.includes('puja') && etiqueta.includes('mínima')) {
      pujaMinima = parsearPrecioBOE(valor) || pujaMinima;
    } else if (etiqueta.includes('depósito') || etiqueta.includes('deposito')) {
      deposito = parsearPrecioBOE(valor) || deposito;
    }
  });

  // Si no tenemos suficiente info, no es un vehículo válido
  if (!titulo && !marca && !descripcion) return null;

  if (!titulo) titulo = [marca, modelo].filter(Boolean).join(' ') || 'Vehículo sin descripción';

  return {
    id_subasta: idSubasta,
    portal: 'BOE',
    enlace: `${BOE_BASE_URL}/detalleSubasta.php?idSub=${idSubasta}&ver=3`,
    id_lote: idLote,
    titulo,
    marca: marca || inferirMarca(titulo + ' ' + descripcion),
    modelo: modelo || inferirModelo(titulo + ' ' + descripcion),
    puja_minima: pujaMinima,
    fecha_inicio: datosGenerales.fechaInicio,
    fecha_fin: datosGenerales.fechaFin,
    provincia: datosGenerales.provincia,
  };
}

function extraerVehiculoDeSeccion(
  $: cheerio.CheerioAPI,
  $seccion: cheerio.Cheerio<any>,
  idSubasta: string,
  idLote: string,
  datosGenerales: DatosGenerales
): Vehiculo | null {
  let titulo = '';
  let marca = '';
  let modelo = '';
  let descripcion = '';
  let pujaMinima = datosGenerales.pujaMinima;

  $seccion.find('th, dt, .etiqueta, .label-campo').each((_i, el) => {
    const etiqueta = $(el).text().trim().toLowerCase();
    const valor = $(el).next('td, dd, .valor-campo, .dato').text().trim();

    if (etiqueta.includes('descripción') || etiqueta.includes('descripcion')) {
      descripcion = valor;
      if (!titulo) titulo = valor;
    } else if (etiqueta.includes('marca')) {
      marca = valor;
    } else if (etiqueta.includes('modelo')) {
      modelo = valor;
    } else if (etiqueta.includes('puja') && etiqueta.includes('mínima')) {
      pujaMinima = parsearPrecioBOE(valor) || pujaMinima;
    }
  });

  if (!titulo && !marca && !descripcion) return null;

  if (!titulo) titulo = [marca, modelo].filter(Boolean).join(' ') || 'Vehículo sin descripción';

  return {
    id_subasta: idSubasta,
    portal: 'BOE',
    enlace: `${BOE_BASE_URL}/detalleSubasta.php?idSub=${idSubasta}&ver=3`,
    id_lote: idLote,
    titulo,
    marca: marca || inferirMarca(titulo + ' ' + descripcion),
    modelo: modelo || inferirModelo(titulo + ' ' + descripcion),
    puja_minima: pujaMinima,
    fecha_inicio: datosGenerales.fechaInicio,
    fecha_fin: datosGenerales.fechaFin,
    provincia: datosGenerales.provincia,
  };
}

function crearVehiculoGenerico(
  $general: cheerio.CheerioAPI,
  $bien: cheerio.CheerioAPI,
  idSubasta: string,
  datosGenerales: DatosGenerales
): Vehiculo | null {
  const tituloGeneral = $general('title').text().trim() || $bien('title').text().trim();
  const textoCompleto = $bien('body').text();

  let titulo = '';
  let descripcion = '';

  const match = textoCompleto.match(/(vehículo|turismo|furgoneta|motocicleta|camión|todoterreno)[^.]{0,200}/i);
  if (match) {
    descripcion = match[0].trim();
    titulo = descripcion.substring(0, 100);
  }

  if (!titulo && !tituloGeneral) return null;
  if (!titulo) titulo = tituloGeneral;

  return {
    id_subasta: idSubasta,
    portal: 'BOE',
    enlace: `${BOE_BASE_URL}/detalleSubasta.php?idSub=${idSubasta}&ver=3`,
    id_lote: '0',
    titulo,
    marca: inferirMarca(titulo + ' ' + descripcion),
    modelo: inferirModelo(titulo + ' ' + descripcion),
    puja_minima: datosGenerales.pujaMinima,
    fecha_inicio: datosGenerales.fechaInicio,
    fecha_fin: datosGenerales.fechaFin,
    provincia: datosGenerales.provincia,
  };
}

// ------------------------------------------------------------
// Utilidades de parseo
// ------------------------------------------------------------

const MARCAS_CONOCIDAS: string[] = [
  'abarth', 'alfa romeo', 'aston martin', 'audi', 'bentley', 'bmw', 'bugatti',
  'cadillac', 'chevrolet', 'chrysler', 'citroen', 'citroën', 'cupra', 'dacia',
  'daewoo', 'dodge', 'ds', 'ferrari', 'fiat', 'ford', 'honda', 'hyundai',
  'infiniti', 'iveco', 'jaguar', 'jeep', 'kia', 'lamborghini', 'lancia',
  'land rover', 'lexus', 'lotus', 'maserati', 'mazda', 'mclaren', 'mercedes',
  'mercedes-benz', 'mg', 'mini', 'mitsubishi', 'nissan', 'opel', 'peugeot',
  'porsche', 'renault', 'rolls-royce', 'rover', 'saab', 'seat', 'skoda',
  'smart', 'ssangyong', 'subaru', 'suzuki', 'tesla', 'toyota', 'volkswagen',
  'volvo', 'yamaha', 'kawasaki', 'harley-davidson', 'ducati', 'piaggio', 'vespa',
];

/**
 * Intenta inferir la marca del vehículo a partir de un texto libre.
 */
function inferirMarca(texto: string): string {
  const textoLower = texto.toLowerCase();
  for (const marca of MARCAS_CONOCIDAS) {
    if (textoLower.includes(marca)) {
      return marca.charAt(0).toUpperCase() + marca.slice(1);
    }
  }
  return 'Desconocida';
}

/**
 * Intenta inferir el modelo del vehículo.
 * Si la marca se encuentra en el texto, toma las 1-3 palabras siguientes como modelo.
 */
function inferirModelo(texto: string): string {
  const textoLower = texto.toLowerCase();
  for (const marca of MARCAS_CONOCIDAS) {
    const idx = textoLower.indexOf(marca);
    if (idx >= 0) {
      const despues = texto.substring(idx + marca.length).trim();
      const palabras = despues.split(/[\s,;.]+/).filter(p => p.length > 0);
      const modelo = palabras.slice(0, 3).join(' ');
      if (modelo.length > 0 && modelo.length < 50) {
        return modelo;
      }
    }
  }
  return '';
}

/**
 * Parsea un precio del BOE. Ej: "1.234,56 €" → 1234.56
 */
function parsearPrecioBOE(texto: string): number {
  if (!texto) return 0;
  // Eliminar todo excepto dígitos, puntos, comas y signo menos
  const limpio = texto.replace(/[^\d.,\-]/g, '').trim();
  if (!limpio) return 0;

  // Formato español: puntos para miles, coma para decimales
  const normalizado = limpio.replace(/\./g, '').replace(',', '.');
  const numero = parseFloat(normalizado);
  return isNaN(numero) ? 0 : numero;
}

/**
 * Parsea una fecha del BOE. El BOE usa formatos variados.
 */
function parsearFechaBOE(texto: string): string {
  if (!texto) return '';

  // Formato habitual: "21-07-2024 18:00:00 CET" o "21/07/2024"
  const match = texto.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s*(\d{1,2}:\d{2}(:\d{2})?)?/);
  if (match) {
    const dia = match[1].padStart(2, '0');
    const mes = match[2].padStart(2, '0');
    const anio = match[3];
    const hora = match[4] ?? '00:00:00';
    return `${anio}-${mes}-${dia}T${hora}`;
  }

  return texto;
}

/**
 * Utilidad para esperar N milisegundos.
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
