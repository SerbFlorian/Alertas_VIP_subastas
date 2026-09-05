import winston from 'winston';
import path from 'path';
import fs from 'fs';

// ============================================================
// LOGGER — Winston (Alertas VIP Subastas)
// Redacción de secretos en message + meta
// ============================================================

const logDir = process.env['LOG_DIR'] ?? './logs';
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Contenedor sin permiso de escritura: solo consola
  }
}

/** Enmascara tokens, claves Stripe/OpenAI, passwords en URLs, etc. */
export function redactSecrets(input: unknown): string {
  let s = typeof input === 'string' ? input : JSON.stringify(input);
  if (!s) return '';

  return s
    .replace(/\d{8,12}:[A-Za-z0-9_-]{30,}/g, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(/sk_live_[A-Za-z0-9]+/g, '[REDACTED_STRIPE_SK]')
    .replace(/sk_test_[A-Za-z0-9]+/g, '[REDACTED_STRIPE_SK]')
    .replace(/whsec_[A-Za-z0-9]+/g, '[REDACTED_STRIPE_WHSEC]')
    .replace(/rk_live_[A-Za-z0-9]+/g, '[REDACTED_STRIPE_RK]')
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, '[REDACTED_OPENAI_KEY]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/(AKIA|ASIA)[A-Z0-9]{16}/g, '[REDACTED_ACCESS_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/:\/\/([^:/@]+):([^@/]+)@/g, '://$1:[REDACTED]@')
    .replace(/([?&](password|pass|token|secret|api_key|apikey|key)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(
      /\b(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|DATABASE_URL|REDIS_URL|POSTGRES_PASSWORD|REDIS_PASSWORD|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID)\s*[=:]\s*\S+/gi,
      '$1=[REDACTED]'
    );
}

const transports: winston.transport[] = [new winston.transports.Console()];

try {
  if (fs.existsSync(logDir)) {
    transports.push(
      new winston.transports.File({
        filename: path.join(logDir, 'subastas-vip.log'),
        maxsize: 5 * 1024 * 1024,
        maxFiles: 3,
      }),
      new winston.transports.File({
        filename: path.join(logDir, 'error.log'),
        level: 'error',
        maxsize: 5 * 1024 * 1024,
        maxFiles: 3,
      })
    );
  }
} catch {
  /* solo consola */
}

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf((info) => {
      const { timestamp, level, message, ...meta } = info;
      const msg = redactSecrets(String(message ?? ''));
      const metaKeys = Object.keys(meta).filter((k) => k !== 'Symbol(level)');
      const metaStr =
        metaKeys.length > 0
          ? ` ${redactSecrets(
              Object.fromEntries(metaKeys.map((k) => [k, (meta as Record<string, unknown>)[k]]))
            )}`
          : '';
      return `${timestamp} [${level}] ${msg}${metaStr}`;
    })
  ),
  transports,
});
