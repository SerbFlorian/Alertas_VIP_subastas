import axios from 'axios';
import { logger, redactSecrets } from '../services/logger';

// ============================================================
// Recordatorio ops mensual — deps + drill restore (no CRITICAL)
// ============================================================

async function sendOpsHtml(html: string): Promise<void> {
  const token = (process.env['TELEGRAM_BOT_TOKEN'] ?? '').trim();
  const chat = (process.env['TELEGRAM_ADMIN_CHAT_ID'] ?? '').trim();
  if (!token || !chat) {
    logger.warn('⚠️ Ops reminder sin TELEGRAM_BOT_TOKEN / ADMIN_CHAT_ID');
    return;
  }
  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      chat_id: chat,
      text: redactSecrets(html).slice(0, 3500),
      parse_mode: 'HTML',
      disable_notification: true,
    },
    { timeout: 12_000 }
  );
}

export async function ejecutarOpsReminderJob(): Promise<void> {
  const when = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  const retention = process.env['BACKUP_RETENTION_DAYS'] ?? '7';

  const text = [
    `🔧 <b>Recordatorio mensual — Alertas VIP Subastas</b>`,
    `<code>${when}</code>`,
    ``,
    `1) <b>Dependencias</b>`,
    `· <code>npm audit --audit-level=high</code>`,
    `· Revisar upgrades menores (Prisma/Telegraf/Stripe)`,
    ``,
    `2) <b>Drill restore</b> (staging o con cuidado)`,
    `· Confirmar último backup R2 (retención ${retention}d)`,
    `· <code>CONFIRM_RESTORE=YES npm run restore:latest</code> solo tras stop controlado`,
    ``,
    `3) <b>Checklist seguridad</b>`,
    `· README §14.7 — ejecutar los comandos de verificación`,
    `· <code>npm run verify:system</code>`,
    ``,
    `4) <b>Producto</b>`,
    `· Revisar cadencia digests (<code>NOTIFIER_INTERVAL_MINUTES</code>)`,
    `· Confirmar Bright Data sigue off`,
  ].join('\n');

  await sendOpsHtml(text);
  logger.info('✅ Ops reminder mensual enviado');
}

if (require.main === module) {
  import('dotenv/config').then(() =>
    ejecutarOpsReminderJob()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      })
  );
}
