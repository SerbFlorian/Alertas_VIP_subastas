import express, { type Request, type Response } from 'express';
import Stripe from 'stripe';
import {
  actualizarEstadoUsuarioPorTelegramId,
  actualizarEstadoUsuarioPorCustomerId,
  programarCancelacionUsuarioPorCustomerId,
  getUsuarioPorTelegramId,
  getUsuarioPorCustomerId,
  reactivarUsuarioPorCustomerId,
} from '../db/queries';
import { generarInviteLink, banearUsuario, enviarMensajeConBotones, enviarMensaje } from '../services/telegram.service';
import { createIpRateLimit } from '../middlewares/http-ratelimit.middleware';
import { logger } from '../services/logger';

// ============================================================
// STRIPE WEBHOOKS — Gestión de pagos y suscripciones
// Alertas VIP Subastas
// ============================================================

export function crearStripeRouter(): express.Router {
  const router = express.Router();
  const stripeSecretKey = (process.env['STRIPE_SECRET_KEY'] ?? '').trim();
  const webhookSecret = (process.env['STRIPE_WEBHOOK_SECRET'] ?? '').trim();

  if (!stripeSecretKey) {
    logger.warn('⚠️  STRIPE_SECRET_KEY no configurada. Los webhooks de Stripe no funcionarán.');
    return router;
  }

  const stripe = new Stripe(stripeSecretKey);

  router.use(createIpRateLimit({ label: 'stripe_webhook' }));

  // Capturar ABSOLUTAMENTE TODO como un Buffer RAW para evitar cualquier problema de parseo
  router.use(express.raw({ type: '*/*' }));

  router.post('/', async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];
    let event: Stripe.Event;

    try {
      if (!webhookSecret) {
        logger.error('❌ STRIPE_WEBHOOK_SECRET no configurada — rechazando webhook');
        res.status(503).json({ error: 'webhook_not_configured' });
        return;
      }
      if (!sig || typeof sig !== 'string') {
        res.status(400).json({ error: 'missing_signature' });
        return;
      }
      if (!Buffer.isBuffer(req.body)) {
        logger.error('❌ FATAL: req.body no es un Buffer. Verifica que no haya un express.json() global.');
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('❌ Error verificando firma de Stripe:', { err: msg });
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }

    logger.info(`📦 Stripe evento recibido: ${event.type}`);

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await manejarPagoCompletado(event.data.object as Stripe.Checkout.Session);
          break;
        case 'customer.subscription.deleted':
          await manejarCancelacionSuscripcion(event.data.object as Stripe.Subscription);
          break;
        case 'customer.subscription.updated':
          await manejarActualizacionSuscripcion(event.data.object as Stripe.Subscription);
          break;
        default:
          logger.info(`ℹ️  Evento ignorado: ${event.type}`);
      }
      res.status(200).json({ received: true });
    } catch (error) {
      logger.error(`❌ Error procesando evento ${event.type}:`, { error });
      // 500 → Stripe reintenta (antes ACK 200 fire-and-forget perdía pagos sin VIP)
      res.status(500).json({ error: 'handler_failed' });
    }
  });

  return router;
}

// ----------------------------------------------------------
// Handler: checkout.session.completed
// ----------------------------------------------------------

async function manejarPagoCompletado(session: Stripe.Checkout.Session): Promise<void> {
  const telegramId = session.client_reference_id;
  const email = session.customer_details?.email ?? undefined;
  const customerId = session.customer as string | undefined;

  if (!telegramId) {
    const admin = process.env['TELEGRAM_ADMIN_CHAT_ID'];
    const detail = `email=${email ?? '—'} customer=${customerId ?? '—'} session=${session.id}`;
    logger.error(`❌ checkout.session.completed SIN client_reference_id — ${detail}`);
    if (admin) {
      await enviarMensaje(
        admin,
        `🚨 Pago Stripe sin telegram_id (client_reference_id). Revisar a mano.\n${detail}`
      ).catch(() => {});
    }
    // Lanzar para que el webhook responda 500 y Stripe reintente / quede visible
    throw new Error('checkout_missing_client_reference_id');
  }

  logger.info(`💳 Pago completado para telegram_id: ${telegramId}, email: ${email}`);

  // 1. Actualizar estado en BD
  await actualizarEstadoUsuarioPorTelegramId(telegramId, 'Pagado', email, customerId);

  // Contador VIP en chat admin
  const { refreshVipCounter } = await import('../services/vip-counter.service');
  await refreshVipCounter().catch(() => {});

  // 2. Confirmación en castellano
  const texto = [
    `🎉 <b>¡Suscripción VIP activada!</b>`,
    ``,
    `Hemos procesado tu pago correctamente${email ? ` (<code>${email}</code>)` : ''}.`,
    ``,
    `🏎️ <b>Siguiente paso</b>`,
    ``,
    `Envía <b>/start</b> para abrir tu panel: configurar el radar (marca, modelo, comunidad, puja) y el asesor IA.`,
  ].join('\n');

  await enviarMensaje(telegramId, texto);
  logger.info(`✅ Confirmación de pago enviada a telegram_id: ${telegramId}`);
}

// ----------------------------------------------------------
// Handler: customer.subscription.deleted
// ----------------------------------------------------------

async function manejarCancelacionSuscripcion(
  subscription: Stripe.Subscription
): Promise<void> {
  const customerId = subscription.customer as string;
  logger.info(`🚫 Cancelación inmediata para Customer ID: ${customerId}`);

  const usuario = await actualizarEstadoUsuarioPorCustomerId(customerId, 'Cancelado');

  if (!usuario) {
    logger.warn(`⚠️  No se encontró usuario con Customer ID: ${customerId}`);
    return;
  }

  const { refreshVipCounter } = await import('../services/vip-counter.service');
  await refreshVipCounter().catch(() => {});

  // Banear del canal VIP (opcional)
  if (usuario.telegram_id) {
    const channelId = process.env['TELEGRAM_GROUP_VIP_ID'];
    if (channelId) {
      const baneado = await banearUsuario(usuario.telegram_id, channelId);
      if (baneado) logger.info(`✅ Usuario ${usuario.telegram_id} baneado del canal VIP.`);
    }
  }

  // Notificar al usuario
  if (usuario.telegram_id) {
    const { getActivePaymentLink } = await import('../bot/telegram.bot');
    const paymentLink = await getActivePaymentLink();
    await enviarMensaje(
      usuario.telegram_id,
      [
        `<b>🚫 Acceso finalizado</b>`,
        ``,
        `Tu suscripción VIP ha finalizado. Ya no recibirás resúmenes ni acceso VIP en el bot.`,
        ``,
        `En <b>${process.env['DATA_PURGE_HOURS'] ?? '48'} h</b> limpiaremos filtros, mensajes con enlace y datos personales (tu ID se conserva).`,
        `Si quieres adelantarlo: /borrar_datos`,
        ``,
        `¡Gracias! Para volver: ${paymentLink || '@SubastasVIP_bot'}`
      ].join('\n')
    );
  }
}

// ----------------------------------------------------------
// Handler: customer.subscription.updated
// ----------------------------------------------------------

async function manejarActualizacionSuscripcion(
  subscription: Stripe.Subscription
): Promise<void> {
  logger.info(`🔍 Debug Updated: ID=${subscription.customer}, status=${subscription.status}, cancel_at_period_end=${subscription.cancel_at_period_end}, cancel_at=${subscription.cancel_at}`);

  if (subscription.cancel_at_period_end || subscription.cancel_at) {
    const customerId = subscription.customer as string;
    const cancelTimestamp = subscription.cancel_at || subscription.current_period_end;
    const fechaFin = new Date(cancelTimestamp * 1000).toLocaleDateString('es-ES');
    const isoDate = new Date(cancelTimestamp * 1000).toISOString();

    logger.info(`⏳ Cancelación programada para Customer ID ${customerId} el ${fechaFin}`);

    const usuarioPrevio = await getUsuarioPorCustomerId(customerId);
    const yaEstabaCancelando = usuarioPrevio?.estado === 'Cancelando';

    const usuario = await programarCancelacionUsuarioPorCustomerId(customerId, isoDate);

    // Enviar notificación a Telegram de que se cancelará a fin de mes (solo si no la habíamos enviado ya)
    if (usuario && usuario.telegram_id && !yaEstabaCancelando) {
      await enviarMensaje(
        usuario.telegram_id,
        [
          `<b>⚠️ Suscripción cancelada</b>`,
          ``,
          `Has cancelado tu suscripción VIP. No te preocupes, <b>seguirás recibiendo alertas según tu radar hasta el ${fechaFin}</b>.`,
          ``,
          `Cuando llegue esa fecha, el acceso VIP (radar, resúmenes e IA ampliada) se desactivará. ¡Aprovecha estos días!`
        ].join('\n')
      );
    }
  } else {
    // Si cancel_at es nulo, significa que la suscripción está activa sin cancelación programada (reactivada)
    const customerId = subscription.customer as string;
    const usuarioPrevio = await getUsuarioPorCustomerId(customerId);

    // Si el usuario estaba marcado como 'Cancelando', es que se ha arrepentido y ha vuelto a reactivar
    if (usuarioPrevio?.estado === 'Cancelando') {
      const usuario = await reactivarUsuarioPorCustomerId(customerId);
      
      logger.info(`✅ Reactivada la suscripción para Customer ID ${customerId}`);

      const { refreshVipCounter } = await import('../services/vip-counter.service');
      await refreshVipCounter().catch(() => {});

      if (usuario && usuario.telegram_id) {
        await enviarMensaje(
          usuario.telegram_id,
          [
            `<b>✅ Suscripción Reactivada</b>`,
            ``,
            `¡Nos alegra tenerte de vuelta! Tu cancelación ha sido anulada con éxito.`,
            `Seguirás disfrutando del acceso VIP a las alertas sin interrupciones.`
          ].join('\n')
        );
      }
    }
  }
}
