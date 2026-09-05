import { createHash } from 'crypto';
import { getTelegramBot } from '../bot/telegram.bot';
import { logger } from './logger';

// ============================================================
// Admin alerts — solo CRITICAL a Telegram (sin dumps / sin ruido)
// ============================================================

const COOLDOWN_MS = parseInt(process.env['ADMIN_ALERT_COOLDOWN_MS'] ?? String(15 * 60_000), 10);
const recent = new Map<string, number>();

function fingerprint(text: string): string {
  return createHash('sha1').update(text.slice(0, 400)).digest('hex').slice(0, 16);
}

function shouldSend(fp: string): boolean {
  const now = Date.now();
  const last = recent.get(fp) ?? 0;
  if (now - last < COOLDOWN_MS) return false;
  recent.set(fp, now);
  // prune map
  if (recent.size > 200) {
    for (const [k, t] of recent) {
      if (now - t > COOLDOWN_MS * 2) recent.delete(k);
    }
  }
  return true;
}

/**
 * Única vía hacia el admin: fallos graves del sistema.
 * No usar para info, éxito de jobs, ni archivos.
 */
export async function sendCriticalAlert(detail: string): Promise<void> {
  const { redactSecrets } = await import('./logger');
  const safeDetail = redactSecrets(detail).slice(0, 3500);

  const adminChatId = process.env['TELEGRAM_ADMIN_CHAT_ID'];
  if (!adminChatId) {
    logger.warn('⚠️ CRITICAL sin TELEGRAM_ADMIN_CHAT_ID:', { detail: safeDetail.slice(0, 120) });
    return;
  }

  const fp = fingerprint(safeDetail);
  if (!shouldSend(fp)) {
    logger.info(`🔇 CRITICAL silenciado (cooldown ${COOLDOWN_MS}ms): ${safeDetail.slice(0, 80)}`);
    return;
  }

  const host = process.env['HOSTNAME'] || 'alertas-bot';
  const when = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const text = [
    `🚨 <b>CRITICAL — Alertas VIP</b>`,
    `<code>${when}</code> · <code>${host}</code>`,
    ``,
    safeDetail,
  ].join('\n');

  try {
    const bot = getTelegramBot();
    await bot.telegram.sendMessage(adminChatId, text, {
      parse_mode: 'HTML',
      disable_notification: false,
    });
    logger.info('✅ CRITICAL enviado al admin');
  } catch (error) {
    logger.error('❌ No se pudo enviar CRITICAL:', {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/** @deprecated Usa sendCriticalAlert — mantenido por compatibilidad */
export async function sendAdminAlert(message: string): Promise<void> {
  await sendCriticalAlert(message);
}
