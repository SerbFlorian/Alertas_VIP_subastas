import type { RequestHandler } from 'express';

// ============================================================
// Rate-limit HTTP por IP (p. ej. webhook Stripe)
// ============================================================

type Bucket = { count: number; resetAt: number };

/**
 * Limita peticiones por IP (req.ip con trust proxy).
 * Defaults: 60 req / 60s — ajustable con STRIPE_WEBHOOK_RATE_LIMIT_*.
 */
export function createIpRateLimit(opts?: {
  max?: number;
  windowMs?: number;
  label?: string;
}): RequestHandler {
  const max =
    opts?.max ??
    parseInt(process.env['STRIPE_WEBHOOK_RATE_LIMIT_MAX'] ?? '60', 10);
  const windowMs =
    opts?.windowMs ??
    parseInt(process.env['STRIPE_WEBHOOK_RATE_LIMIT_WINDOW_MS'] ?? '60000', 10);
  const label = opts?.label ?? 'http';
  const hits = new Map<string, Bucket>();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let b = hits.get(ip);

    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      hits.set(ip, b);
    }

    b.count += 1;
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      res.status(429).json({ error: 'rate_limited', scope: label });
      return;
    }

    // prune ocasional
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now >= v.resetAt) hits.delete(k);
      }
    }

    next();
  };
}
