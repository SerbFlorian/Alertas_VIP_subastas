import axios from 'axios';
import { logger } from './logger';
import type { VehiculoDB } from '../types';
import { esVehiculoDeLujo } from '../types';

// ============================================================
// TELEGRAM SERVICE — Alertas VIP Subastas
// Envío de mensajes y gestión de miembros vía API de Telegram
// ============================================================

const TELEGRAM_API = 'https://api.telegram.org/bot';

function getToken(): string {
  return process.env['TELEGRAM_BOT_TOKEN'] ?? '';
}

// ------------------------------------------------------------
// Envío de mensajes
// ------------------------------------------------------------

/**
 * Envía un mensaje de texto a un chat/canal/usuario.
 */
export async function enviarMensaje(
  chatId: string,
  texto: string,
  messageThreadId?: number,
  opts?: { disableWebPagePreview?: boolean }
): Promise<number | null> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${getToken()}/sendMessage`, {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      text: texto,
      parse_mode: 'HTML',
      disable_web_page_preview: opts?.disableWebPagePreview ?? true,
    });
    return response.data?.result?.message_id ?? null;
  } catch (error) {
    logger.error('❌ Error enviando mensaje Telegram:', { error: (error as Error).message, chatId, messageThreadId });
    return null;
  }
}

/**
 * Envía un mensaje con botones inline a un chat/usuario.
 */
export async function enviarMensajeConBotones(
  chatId: string,
  texto: string,
  botones: { text: string; url: string }[],
  messageThreadId?: number
): Promise<number | null> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${getToken()}/sendMessage`, {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      text: texto,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      reply_markup: {
        inline_keyboard: botones.map(b => [b]),
      },
    });
    return response.data?.result?.message_id ?? null;
  } catch (error) {
    logger.error('❌ Error enviando mensaje con botones:', { error: (error as Error).message });
    return null;
  }
}

/**
 * Elimina un mensaje de Telegram.
 */
export async function eliminarMensaje(chatId: string, messageId: number): Promise<boolean> {
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Gestión de miembros
// ------------------------------------------------------------

/**
 * Genera un enlace de invitación de un solo uso para un chat/canal.
 */
export async function generarInviteLink(chatId: string): Promise<string | null> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${getToken()}/createChatInviteLink`, {
      chat_id: chatId,
      member_limit: 1,
      name: `VIP Subastas ${Date.now()}`,
    });
    return response.data?.result?.invite_link ?? null;
  } catch (error) {
    logger.error('❌ Error generando invite link:', { error: (error as Error).message });
    return null;
  }
}

/**
 * Banea a un usuario de un chat/canal.
 */
export async function banearUsuario(telegramId: string, chatId: string): Promise<boolean> {
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/banChatMember`, {
      chat_id: chatId,
      user_id: telegramId,
    });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Genera un enlace público permanente (para canal gratuito / demo).
 */
export async function generarEnlacePublicoPermanente(chatId: string): Promise<string | null> {
  try {
    const response = await axios.post(`${TELEGRAM_API}${getToken()}/createChatInviteLink`, {
      chat_id: chatId,
      name: 'Enlace público subastas',
      creates_join_request: false,
    });
    return response.data?.result?.invite_link ?? null;
  } catch (error) {
    logger.error('❌ Error generando enlace público:', { error: (error as Error).message });
    return null;
  }
}

// ------------------------------------------------------------
// Formateo de mensajes para publicar subastas
// ------------------------------------------------------------

/**
 * Formatea un vehículo como mensaje de Telegram listo para publicar.
 * Si es un coche de lujo, genera un mensaje de alto impacto.
 */
export function formatearMensajeVehiculo(v: VehiculoDB): string {
  const esLujo = esVehiculoDeLujo(v);

  if (esLujo) {
    return formatearMensajeLujo(v);
  }
  return formatearMensajeNormal(v);
}

/**
 * Formatea un vehículo para el CANAL PÚBLICO GRATUITO.
 * Estilo “muestra del día” (como radar inmobiliario): sin enlace a la subasta,
 * CTA a VIP con preview de t.me.
 */
export function formatearMensajeVehiculoPublico(v: VehiculoDB): string {
  const botUser = (process.env['TELEGRAM_BOT_USERNAME'] ?? 'SubastasVIP_bot').replace(/^@/, '');
  const vipUrl = `https://t.me/${botUser}`;
  const titulo = escapeHtml(tituloPublicoLimpio(v));
  const precio = formatearPrecio(v.puja_minima);
  const ubicacion = escapeHtml(
    (v.comunidad_autonoma || v.provincia || 'España').toUpperCase()
  );
  const portal = escapeHtml(v.portal || 'BOE');
  const fechaFin = v.fecha_fin ? formatearFecha(v.fecha_fin) : 'sin fecha';
  const headline = headlinePublico(v.fecha_fin);

  return [
    `<b>Radar Subastas de Vehículos (Gratis)</b>`,
    `🚨 <b>${headline}</b>`,
    `<i>Publicación de referencia del radar.</i>`,
    ``,
    `🚗 ${titulo}`,
    `💰 ${precio}`,
    `📍 ${ubicacion}`,
    `⏰ Cierra: ${fechaFin}`,
    `🏛️ ${portal}`,
    ``,
    `<i>Muestra del sistema. VIP: digests con hasta 3 lotes y enlace directo según tu radar.</i>`,
    `────────`,
    `👉 <a href="${vipUrl}"><b>Pasarse a VIP</b></a>`,
  ].join('\n');
}

/** Título legible (evita basura tipo "OTROS MOTOR MARCA …"). */
function tituloPublicoLimpio(v: VehiculoDB): string {
  const marca = (v.marca || '').trim();
  const modelo = (v.modelo || '').trim();
  const joined = `${marca} ${modelo}`.trim();
  const basura =
    !joined ||
    /otros\s*motor/i.test(joined) ||
    /^marca\b/i.test(joined) ||
    /\bmarca\b.+\bmodelo\b/i.test(joined);

  if (!basura) {
    return toTitleCaseEs(joined);
  }

  const t = (v.titulo || '').trim().replace(/\s+/g, ' ');
  if (!t) return 'Vehículo en subasta';
  return t.length > 90 ? `${t.slice(0, 87)}…` : t;
}

function headlinePublico(fechaFin?: string | Date | null): string {
  if (!fechaFin) return 'Chollo de muestra del día';
  const t = fechaFin instanceof Date ? fechaFin.getTime() : new Date(fechaFin).getTime();
  if (Number.isNaN(t)) return 'Chollo de muestra del día';
  const hours = (t - Date.now()) / 3_600_000;
  if (hours > 0 && hours <= 6) return 'Cierra en pocas horas';
  if (hours > 0 && hours <= 24) return 'Chollo de muestra del día';
  return 'Chollo de muestra del día';
}

function toTitleCaseEs(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Formato estándar para vehículos normales.
 */
function formatearMensajeNormal(v: VehiculoDB): string {
  const marcaModelo = [v.marca, v.modelo].filter(Boolean).join(' ').toUpperCase() || v.titulo;
  const fechaFin = v.fecha_fin ? formatearFecha(v.fecha_fin) : 'Sin fecha';
  const ubicacionStr = v.comunidad_autonoma || v.provincia || 'España';

  const partes: string[] = [
    `🚗 <b>${marcaModelo}</b> | 🏛️ ${v.portal ?? 'BOE'}`,
    ``,
    `💰 <b>Precio actual:</b> ${formatearPrecio(v.puja_minima)}`,
    `⏰ <b>Cierra:</b> ${fechaFin} h`,
  ];

  if (ubicacionStr) {
    partes.push(`📍 <b>Ubicación:</b> ${ubicacionStr}`);
  }

  partes.push(``);
  partes.push(`🔗 <a href="${v.enlace}">Ver subasta en ${v.portal}</a>`);

  return partes.join('\n');
}

/**
 * Formato IMPACTANTE para vehículos de LUJO.
 */
function formatearMensajeLujo(v: VehiculoDB): string {
  const marcaModelo = [v.marca, v.modelo].filter(Boolean).join(' ').toUpperCase() || v.titulo;
  const fechaFin = v.fecha_fin ? formatearFecha(v.fecha_fin) : 'Sin fecha';
  const ubicacionStr = v.comunidad_autonoma || v.provincia || 'España';

  const partes: string[] = [
    `🚨🔥🚨🔥🚨🔥🚨🔥🚨🔥`,
    ``,
    `⚡️ <b>¡¡¡SUBASTA DE LUJO!!!</b> ⚡️`,
    ``,
    `🏎️ <b>${marcaModelo}</b> | 🏛️ ${v.portal ?? 'BOE'}`,
    ``,
    `💎 <b>PRECIO ACTUAL:</b> ${formatearPrecio(v.puja_minima)}`,
    `⏰ <b>Cierra:</b> ${fechaFin} h`,
    `📍 <b>Ubicación:</b> ${ubicacionStr}`,
    ``,
    `👇 <b>¡CORRE, ESTOS VUELAN!</b>`,
    `🔗 <a href="${v.enlace}">🏎️ VER SUBASTA AHORA</a>`,
    ``,
    `🚨🔥🚨🔥🚨🔥🚨🔥🚨🔥`
  ];

  return partes.join('\n');
}

// ------------------------------------------------------------
// Utilidades de formato
// ------------------------------------------------------------

export function formatearPrecio(precio: number): string {
  if (precio === 0) return 'Sin mínimo';
  const n = Math.round(Number(precio) || 0);
  const miles = n.toLocaleString('es-ES', {
    useGrouping: true,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  return `${miles} €`;
}

function formatearFecha(fechaISO: string): string {
  try {
    const fecha = new Date(fechaISO);
    return fecha.toLocaleString('es-ES', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Madrid',
    });
  } catch {
    return fechaISO;
  }
}
