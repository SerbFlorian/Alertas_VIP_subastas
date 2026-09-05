import { Context, MiddlewareFn } from 'telegraf';

const limitMap = new Map<number, { count: number; timer: NodeJS.Timeout }>();

const WINDOW_MS = 1500; // 1.5 segundos
const MAX_MESSAGES = 6; // Permite pulsar hasta 6 botones seguidos sin bloqueo

export function rateLimiter(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (!ctx.from) return next();
    
    // Ignorar rate limiter en clics de botones inline (callback_query) para una interacción 100% fluida
    if (ctx.callbackQuery) {
      return next();
    }

    const userId = ctx.from.id;
    const record = limitMap.get(userId);

    if (record) {
      record.count++;
      if (record.count > MAX_MESSAGES) {
        if (record.count === MAX_MESSAGES + 1) {
          try {
            await ctx.reply('⚠️ Has enviado varios mensajes seguidos. Por favor, espera un segundo.');
          } catch (e) {
            // ignorar si no se puede responder
          }
        }
        return; // Ignorar exceso de mensajes de texto
      }
    } else {
      const timer = setTimeout(() => {
        limitMap.delete(userId);
      }, WINDOW_MS);
      limitMap.set(userId, { count: 1, timer });
    }

    return next();
  };
}
