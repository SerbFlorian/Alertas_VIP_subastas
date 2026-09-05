import { getAdminChatId } from '../utils/admin';
import axios from 'axios';
import { getCountUsuariosVIPActivos } from '../db/queries';
import { getRedis, isRedisAvailable } from '../db/redis';
import { prisma } from '../db/prisma';
import { logger, redactSecrets } from './logger';

// ============================================================
// Contador VIP en chat admin — un mensaje “cajita” que se edita
// ============================================================

const META_KEY = 'admin_vip_counter_msg_id';
const REDIS_KEY = 'admin:vip_counter_msg_id';
const TELEGRAM_API = 'https://api.telegram.org/bot';

let memoryMsgId: number | null = null;
let refreshing = false;

function getToken(): string {
  return (process.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
}

function adminChatId(): string {
  return getAdminChatId();
}

function adminTopicId(): number | undefined {
  const raw = (process.env['TELEGRAM_ADMIN_TOPIC_ID'] ?? '').trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function tierLabel(count: number): string {
  const t1 = parseInt(process.env['STRIPE_TIER1_MAX'] ?? '200', 10);
  const t2 = parseInt(process.env['STRIPE_TIER2_MAX'] ?? '1000', 10);
  if (count <= t1) return `Tier 1 (≤${t1})`;
  if (count <= t2) return `Tier 2 (≤${t2})`;
  return `Tier 3 (>${t2})`;
}

function formatCounterBox(count: number): string {
  const n = String(count);
  const width = Math.max(8, n.length + 4);
  const pad = Math.max(0, Math.floor((width - n.length) / 2));
  const inner = ' '.repeat(pad) + n + ' '.repeat(width - pad - n.length);
  const bar = '═'.repeat(width);
  const when = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

  return [
    `💎 <b>VIP activos</b>`,
    `<pre>`,
    `╔${bar}╗`,
    `║${inner}║`,
    `╚${bar}╝`,
    `</pre>`,
    `Precio actual: <b>${tierLabel(count)}</b>`,
    `<i>${when}</i>`,
  ].join('\n');
}

/** Texto de la cajita (mismo diseño que el mensaje fijado en admin). */
export async function buildVipCounterMessage(): Promise<string> {
  const count = await getCountUsuariosVIPActivos();
  return formatCounterBox(count);
}

async function loadMsgId(): Promise<number | null> {
  if (memoryMsgId != null) return memoryMsgId;

  const envId = parseInt(process.env['TELEGRAM_ADMIN_VIP_COUNTER_MSG_ID'] ?? '', 10);
  if (Number.isFinite(envId) && envId > 0) {
    memoryMsgId = envId;
    return envId;
  }

  const redis = isRedisAvailable() ? getRedis() : null;
  if (redis) {
    const v = await redis.get(REDIS_KEY);
    if (v) {
      const id = parseInt(v, 10);
      if (Number.isFinite(id)) {
        memoryMsgId = id;
        return id;
      }
    }
  }

  try {
    const row = await prisma.appMeta.findUnique({ where: { key: META_KEY } });
    if (row?.value) {
      const id = parseInt(row.value, 10);
      if (Number.isFinite(id)) {
        memoryMsgId = id;
        return id;
      }
    }
  } catch {
    /* tabla aún no migrada */
  }

  return null;
}

async function saveMsgId(id: number): Promise<void> {
  memoryMsgId = id;

  const redis = isRedisAvailable() ? getRedis() : null;
  if (redis) {
    await redis.set(REDIS_KEY, String(id)).catch(() => {});
  }

  try {
    await prisma.appMeta.upsert({
      where: { key: META_KEY },
      create: { key: META_KEY, value: String(id) },
      update: { value: String(id) },
    });
  } catch (e) {
    logger.warn(`vip-counter: no se pudo persistir msg_id en BD: ${(e as Error).message}`);
  }
}

async function editMessage(chatId: string, messageId: number, text: string): Promise<boolean> {
  try {
    await axios.post(`${TELEGRAM_API}${getToken()}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return true;
  } catch (e) {
    const msg = (e as { response?: { data?: { description?: string } }; message?: string }).response?.data
      ?.description;
    logger.warn(`vip-counter edit falló: ${redactSecrets(msg || (e as Error).message)}`);
    return false;
  }
}

async function sendMessage(chatId: string, text: string): Promise<number | null> {
  try {
    const topic = adminTopicId();
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: true,
    };
    if (topic != null) body['message_thread_id'] = topic;

    const res = await axios.post(`${TELEGRAM_API}${getToken()}/sendMessage`, body);
    return (res.data?.result?.message_id as number) ?? null;
  } catch (e) {
    logger.error(`vip-counter send falló: ${(e as Error).message}`);
    return null;
  }
}

/** Actualiza (o crea) la cajita del contador VIP en el chat admin. */
export async function refreshVipCounter(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const chat = adminChatId();
    const token = getToken();
    if (!chat || !token) return;

    const count = await getCountUsuariosVIPActivos();
    const text = formatCounterBox(count);

    let msgId = await loadMsgId();
    if (msgId != null) {
      const ok = await editMessage(chat, msgId, text);
      if (ok) {
        logger.info(`💎 Contador VIP actualizado: ${count}`);
        return;
      }
      // Mensaje borrado → crear uno nuevo
      memoryMsgId = null;
      msgId = null;
    }

    const created = await sendMessage(chat, text);
    if (created != null) {
      await saveMsgId(created);
      logger.info(`💎 Contador VIP creado (msg ${created}): ${count}`);
    }
  } catch (e) {
    logger.error(`vip-counter: ${(e as Error).message}`);
  } finally {
    refreshing = false;
  }
}
