import type { Context } from 'telegraf';

/**
 * Admin de Telegram: solo user IDs explícitos (nunca el chat de grupo -100…).
 * Env: TELEGRAM_ADMIN_USER_IDS=111,222  o  TELEGRAM_ADMIN_USER_ID=111
 */
export function getAdminUserIds(): Set<string> {
  const raw = [
    process.env['TELEGRAM_ADMIN_USER_IDS'] ?? '',
    process.env['TELEGRAM_ADMIN_USER_ID'] ?? '',
  ].join(',');

  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('-'));

  return new Set(ids);
}

export function isTelegramAdmin(ctx: Context): boolean {
  const fromId = String(ctx.from?.id ?? '');
  if (!fromId) return false;
  return getAdminUserIds().has(fromId);
}

/** Normaliza chat IDs del .env (quita comillas / espacios). */
export function getAdminChatId(): string {
  return (process.env['TELEGRAM_ADMIN_CHAT_ID'] ?? '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

export function isAdminChat(ctx: Context): boolean {
  const admin = getAdminChatId();
  if (!admin) return false;
  return String(ctx.chat?.id ?? '') === admin;
}

/** Comando /vip_count o /vip_count@BotName */
export function isVipCountCommand(text: string): boolean {
  const cmd = text.trim().split(/\s+/)[0]?.split('@')[0]?.toLowerCase() ?? '';
  return cmd === '/vip_count';
}
