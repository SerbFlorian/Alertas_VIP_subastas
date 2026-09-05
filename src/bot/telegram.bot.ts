import { Telegraf, Context, Markup } from 'telegraf';
import { registrarUsuario, getUsuarioPorTelegramId } from '../db/queries';
import {
  AI_VIP_DAILY_MAX,
  AI_VIP_WEEKLY_MAX,
  AI_FREE_MAX,
  AI_AD_RECOVERY_DAILY_MAX,
  AI_BROKEN_LINK_DAILY_MAX,
} from '../db/queries';
import { generarEnlacePublicoPermanente } from '../services/telegram.service';
import { logger } from '../services/logger';
import { mostrarPanelFiltros, registerFilterHandlers } from './filters.menu';
import { abrirHorario, setupHorarioMenu } from './horario.menu';

// ============================================================
// TELEGRAM BOT — Bot de entrada para usuarios
// Alertas VIP Subastas — Vehículos Embargados del BOE
// ============================================================

let bot: Telegraf | null = null;

import { rateLimiter } from '../middlewares/ratelimit.middleware';

export function getTelegramBot(): Telegraf {
  if (bot) return bot;

  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN no configurado en .env');
    throw new Error('TELEGRAM_BOT_TOKEN no configurado en .env');
  }

  bot = new Telegraf(token);
  configurarHandlers(bot);
  return bot;
}

// ------------------------------------------------------------
// Handlers del bot
// ------------------------------------------------------------

function configurarHandlers(botInstance: Telegraf): void {

  // Anti-spam global (max 1 mensaje/segundo)
  botInstance.use(rateLimiter());

  // Privado = todo. Admin chat (grupo O canal) = todo lo que el bot pueda manejar.
  botInstance.use(async (ctx, next) => {
    if (ctx.chat?.type === 'private') {
      await next();
      return;
    }
    const { isAdminChat } = await import('../utils/admin');
    if (isAdminChat(ctx)) {
      await next();
    }
  });

  const textoAsesor = (esVIP: boolean) =>
    [
      `🤖 <b>Asesor de subastas (IA)</b>`,
      ``,
      `Escribe aquí cuando quieras valorar una puja, preguntar por riesgos de un lote o comparar opciones.`,
      `También para recuperar una subasta perdida o pedir alternativa si un enlace está caído. Enfocado en vehículos embargados (BOE, Escrapalia, eActivos, Procuradores).`,
      ``,
      `🆓 <b>Versión gratuita</b>`,
      `<blockquote>«${AI_FREE_MAX} interacciones»\n• Consejo de pujas/riesgos sin anuncio\n• Al recuperar: 1 ficha (sin enlace)</blockquote>`,
      ``,
      `💎 <b>VIP</b>`,
      `<blockquote>«Chat: hasta ${AI_VIP_DAILY_MAX}/día y ${AI_VIP_WEEKLY_MAX}/semana»\n• Consejo sin anuncio\n• Recuperar subasta perdida: hasta ${AI_AD_RECOVERY_DAILY_MAX} enlaces/día (solo cuenta si hay anuncio)\n• Enlace roto → alternativa: ${AI_BROKEN_LINK_DAILY_MAX}/día (solo si hay anuncio)\n• Digests del radar: hasta 3 lotes con enlace</blockquote>`,
      ``,
      `💬 <b>Ejemplos de consejo (sin anuncio ni enlace)</b>`,
      `<blockquote>¿Merece la pena pujar por un Dacia Duster con 2.000 € de puja mínima en Galicia?\n\n¿Qué riesgos mirar antes de pujar en BOE vs Escrapalia?\n\nAudi A3 o Seat León para alguien que busca poco mantenimiento — ¿qué mirarías en subasta?</blockquote>`,
      ``,
      `🎁 <b>Recompensa si hay un enlace roto</b> <i>(${AI_BROKEN_LINK_DAILY_MAX}/día VIP)</i>`,
      esVIP
        ? `Si un «Subasta encontrada» ya no funciona, dile al asesor <b>«el enlace está caído»</b> o <b>«dame una alternativa»</b> y descríbele marca/modelo/comunidad/puja. Te buscará <b>1 lote real</b> de la BD lo más parecido posible — no usa automáticamente solo los filtros de tu radar.`
        : `Solo VIP: enlaces clicables y 1 alternativa/día si un anuncio cae. En prueba gratuita, al recuperar ves la ficha completa pero sin enlace.`,
      ``,
      `🔄 <b>Recuperar una subasta</b> <i>(hasta ${AI_AD_RECOVERY_DAILY_MAX}/día VIP con enlace)</i>`,
      `Si perdiste un lote que viste (o solo recuerdas parte), descríbemelo y te ayudo a recuperarlo o a encontrar uno parecido. Cuantos más datos, más cerca. Los cupos se reinician cada día. Máx. 2 min de búsqueda.`,
      ``,
      `📝 <b>Ejemplos para recuperar (aquí sí hay ficha + enlace VIP)</b>`,
      `<blockquote>Dacia Duster en Galicia, puja menos de 2.000 €. <b>Dame el link del anuncio.</b>\n👉 <b>Subasta encontrada</b>\n\nAudi A3 en Madrid, aprox. 1.500 € de puja. <b>Dame el link del anuncio.</b>\n👉 <b>Subasta encontrada</b>\n\nSeat León en Cataluña, menos de 1.000 €. <b>Dame el link del anuncio.</b>\n👉 <b>Subasta encontrada</b></blockquote>`,
      ``,
      `<i>Tip: la ficha y el enlace «Subasta encontrada» solo aparecen al recuperar un anuncio o por enlace caído — no al pedir consejo de puja.</i>`,
    ].join('\n');

  const responderAsesor = async (ctx: Context) => {
    const telegramId = String(ctx.from?.id ?? '');
    const user = telegramId ? await getUsuarioPorTelegramId(telegramId) : null;
    const esVIP = user?.estado === 'Pagado' || user?.estado === 'Cancelando';
    await ctx.reply(textoAsesor(!!esVIP), { parse_mode: 'HTML' });
  };

  const responderVipCount = async (ctx: Context) => {
    const { isTelegramAdmin, isAdminChat, getAdminChatId } = await import('../utils/admin');
    if (!isAdminChat(ctx) && !isTelegramAdmin(ctx)) return;

    const { buildVipCounterMessage, refreshVipCounter } = await import('../services/vip-counter.service');
    const text = await buildVipCounterMessage();

    try {
      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (e) {
      const { enviarMensaje } = await import('../services/telegram.service');
      await enviarMensaje(getAdminChatId() || String(ctx.chat?.id ?? ''), text);
      logger.warn(`vip_count: reply falló, usado sendMessage — ${(e as Error).message}`);
    }

    await refreshVipCounter().catch(() => {});
  };

  const responderTopicId = async (ctx: Context) => {
    const { isTelegramAdmin, isAdminChat } = await import('../utils/admin');
    if (!isTelegramAdmin(ctx) && !isAdminChat(ctx)) return;

    const msg = ctx.message ?? ctx.channelPost;
    const topicId =
      msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined;
    const id = ctx.chat?.id;
    const tipo = ctx.chat?.type ?? '?';
    if (topicId) {
      await ctx.reply(`El TOPIC_ID de este tema es: ${topicId}\nEl CHAT_ID es: ${id}\nTipo: ${tipo}`);
    } else {
      await ctx.reply(`CHAT_ID: <code>${id}</code>\nTipo: <b>${tipo}</b>`, { parse_mode: 'HTML' });
    }
  };

  /** En canales Telegram manda channel_post (no message) → hay que enrutar a mano. */
  const routeAdminCommand = async (ctx: Context, raw: string): Promise<boolean> => {
    const cmd = raw.trim().split(/\s+/)[0]?.split('@')[0]?.toLowerCase() ?? '';
    switch (cmd) {
      case '/vip_count':
        await responderVipCount(ctx);
        return true;
      case '/get_topic_id':
        await responderTopicId(ctx);
        return true;
      case '/start':
        await enviarMensajeBienvenida(ctx);
        return true;
      case '/estado':
        await mostrarEstado(ctx);
        return true;
      case '/filtros':
      case '/radar':
        await mostrarPanelFiltros(ctx);
        return true;
      case '/horario':
      case '/schedule':
        await abrirHorario(ctx);
        return true;
      case '/asesor':
        await responderAsesor(ctx);
        return true;
      case '/borrar_datos':
        await borrarDatos(ctx);
        return true;
      case '/help':
      case '/comandos':
        await ctx.reply(
          [
            `🛠 <b>Comandos admin (subastas)</b>`,
            ``,
            `/vip_count — contador VIP`,
            `/get_topic_id — CHAT_ID / topic`,
            `/start /filtros /horario /asesor /estado /borrar_datos`,
            ``,
            `<i>Si este chat es un <b>canal</b>, el menú “/” de Telegram casi no lista bots; escribe el comando a mano o usa un <b>grupo privado</b> para el menú completo.</i>`,
          ].join('\n'),
          { parse_mode: 'HTML' }
        );
        return true;
      default:
        return false;
    }
  };

  botInstance.start(enviarMensajeBienvenida);
  botInstance.command('estado', mostrarEstado);
  botInstance.command('borrar_datos', borrarDatos);
  botInstance.command('filtros', mostrarPanelFiltros);
  botInstance.command('radar', mostrarPanelFiltros);
  botInstance.command('horario', abrirHorario);
  botInstance.command('schedule', abrirHorario);
  botInstance.command('asesor', responderAsesor);
  botInstance.command('vip_count', responderVipCount);
  botInstance.command('get_topic_id', responderTopicId);
  botInstance.command('help', async (ctx) => {
    const { isAdminChat, isTelegramAdmin } = await import('../utils/admin');
    if (isAdminChat(ctx) || isTelegramAdmin(ctx)) {
      await routeAdminCommand(ctx, '/help');
    }
  });
  botInstance.command('comandos', async (ctx) => {
    const { isAdminChat, isTelegramAdmin } = await import('../utils/admin');
    if (isAdminChat(ctx) || isTelegramAdmin(ctx)) {
      await routeAdminCommand(ctx, '/comandos');
    }
  });

  botInstance.hears(/^\/vip_count(?:@\w+)?$/i, async (ctx, next) => {
    const entities = ctx.message?.entities ?? [];
    if (entities.some((e) => e.type === 'bot_command' && e.offset === 0)) {
      return next();
    }
    await responderVipCount(ctx);
  });

  // CANAL admin: los posts llegan como channel_post (por eso no respondía nada)
  botInstance.on('channel_post', async (ctx) => {
    const { isAdminChat } = await import('../utils/admin');
    if (!isAdminChat(ctx)) return;

    const text =
      ctx.channelPost && 'text' in ctx.channelPost
        ? String(ctx.channelPost.text ?? '').trim()
        : '';
    if (!text.startsWith('/')) return;

    logger.info(`📢 channel_post admin: ${text.split(/\s+/)[0]}`);
    await routeAdminCommand(ctx, text);
  });

  botInstance.action('ver_estado', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarEstado(ctx);
  });

  botInstance.action('configurar_filtros', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarPanelFiltros(ctx);
  });

  registerFilterHandlers(botInstance);
  setupHorarioMenu(botInstance);

  botInstance.on('text', async (ctx, next) => {
    const text = ctx.message.text?.trim() ?? '';
    if (text.startsWith('/')) return next();

    const telegramId = String(ctx.from?.id ?? '');
    await registrarUsuario(telegramId);

    const { puedeUsarIA, consumirPruebaIA, consumirUsoIAVip } = await import('../db/queries');
    const acceso = await puedeUsarIA(telegramId);

    if (!acceso.ok) {
      if (acceso.motivo === 'diario') {
        await ctx.reply(
          `🤖 Has llegado al límite diario del asesor (<b>${AI_VIP_DAILY_MAX}</b> mensajes). Vuelve mañana.`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      if (acceso.motivo === 'semanal') {
        await ctx.reply(
          `🤖 Has llegado al límite semanal del asesor (<b>${AI_VIP_WEEKLY_MAX}</b> mensajes). Se renueva el lunes.`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      await ctx.reply(
        [
          `🤖 Has agotado tus <b>3 mensajes de prueba</b> del asesor IA.`,
          ``,
          `Con VIP tienes asesor (hasta ${AI_VIP_DAILY_MAX}/día · ${AI_VIP_WEEKLY_MAX}/semana), radar y resúmenes con enlace.`,
          `Usa /start para suscribirte.`,
        ].join('\n'),
        { parse_mode: 'HTML' }
      );
      return;
    }

    await ctx.sendChatAction('typing');
    const typing = setInterval(() => {
      void ctx.sendChatAction('typing');
    }, 4000);

    try {
      const { handleAiMessage } = await import('../services/ai.service');
      const result = await handleAiMessage(telegramId, text);

      // Solo descontar cupo si OpenAI respondió bien (no cobrar fallos de red)
      let suffix = '';
      if (result.ok) {
        if (!acceso.esVip) {
          const restantes = await consumirPruebaIA(telegramId);
          suffix =
            restantes > 0
              ? `\n\n<i>🧪 Te quedan ${restantes} mensaje(s) de prueba.</i>`
              : `\n\n<i>🧪 Era tu último mensaje de prueba. Hazte VIP en /start para seguir.</i>`;
        } else {
          const restantes = await consumirUsoIAVip(telegramId);
          if (restantes <= 5) {
            suffix = `\n\n<i>🤖 Cupo asesor: te quedan ${restantes} mensaje(s) (día/semana).</i>`;
          }
        }
      }

      const finalText = result.text + suffix;
      await ctx
        .reply(finalText, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        })
        .catch(async () => {
          await ctx.reply(finalText.replace(/<[^>]+>/g, ''));
        });
    } finally {
      clearInterval(typing);
    }
  });

  botInstance.catch((err: unknown, ctx: Context) => {
    logger.error(`❌ Error en bot para update ${ctx.updateType}:`, { err });
  });
}

// ------------------------------------------------------------
// Comando /estado
// ------------------------------------------------------------

async function mostrarEstado(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;

  const user = await getUsuarioPorTelegramId(telegramId);

  if (!user) {
    await ctx.reply('No estás registrado. Usa /start para comenzar.');
    return;
  }

  let emoji = '⏳';
  let estadoDisplay = 'Pendiente (Esperando activación)';

  if (user.estado === 'Pagado') {
    emoji = '✅';
    estadoDisplay = 'VIP Activo';
  } else if (user.estado === 'Cancelando') {
    emoji = '⚠️';
    const fechaCancel = user.cancel_at ? new Date(user.cancel_at).toLocaleDateString('es-ES') : 'próximamente';
    estadoDisplay = `Cancelada (Activa hasta el ${fechaCancel})`;
  }

  const fechaRegistro = user.created_at ? new Date(user.created_at).toLocaleDateString('es-ES') : 'Desconocida';
  const texto = [
    `📋 <b>Tu estado en Subastas VIP</b>`,
    ``,
    `${emoji} <b>Suscripción:</b> ${estadoDisplay}`,
  ];

  const esVIP = user.estado === 'Pagado' || user.estado === 'Cancelando';

  if (esVIP) {
    texto.push(`📅 <b>Miembro VIP desde:</b> ${fechaRegistro}`);
    try {
      const {
        loadDigestPrefs,
        formatDigestDays,
        formatHourRange,
      } = await import('../services/digest-schedule.service');
      const prefs = await loadDigestPrefs(telegramId);
      texto.push(
        ``,
        `⏰ <b>Horario resúmenes:</b> ${formatDigestDays(prefs.days)} · ${formatHourRange(prefs.startHour, prefs.endHour)} · cada ${prefs.intervalH} h`,
        `<i>Cámbialo con /horario</i>`
      );
    } catch {
      /* ignore */
    }
  }

  texto.push(
    ``,
    esVIP
      ? `🏎️ Recibirás resúmenes de subastas según tu radar (marca, modelo, comunidad y puja).`
      : `👇 Suscríbete al plan VIP para configurar tu radar y recibir alertas con enlace.`
  );

  await ctx.reply(texto.join('\n'), { parse_mode: 'HTML' });
}

// ------------------------------------------------------------
// Comando /borrar_datos
// ------------------------------------------------------------

async function borrarDatos(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;

  const user = await getUsuarioPorTelegramId(telegramId);
  if (!user) {
    await ctx.reply('No tengo ningún dato tuyo registrado.');
    return;
  }

  if (user.estado === 'Pagado') {
    await ctx.reply(
      [
        `⚠️ Tienes una suscripción VIP <b>activa</b>.`,
        ``,
        `Cancela primero en <b>Gestionar mi suscripción</b> (/start).`,
        `Cuando el VIP termine, podrás usar /borrar_datos o el sistema limpiará tus datos personales a las 48 h (se conserva tu ID para no abusar del plan gratuito).`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (user.estado === 'Cancelando') {
    const fechaCancel = user.cancel_at
      ? new Date(user.cancel_at).toLocaleDateString('es-ES')
      : 'próximamente';
    await ctx.reply(
      [
        `⚠️ Tu VIP sigue activo hasta el <b>${fechaCancel}</b>.`,
        ``,
        `Cuando finalice pasarás a plan gratuito y entonces podrás usar /borrar_datos, o el sistema limpiará filtros, mensajes con enlace y datos personales a las <b>48 h</b>.`,
        `Tu ID de Telegram se conserva para que no se reinicien las 3 pruebas gratis de la IA.`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Solo tras VIP finalizado (Cancelado) o ya en freemium post-purga no aplica — Pendiente_Pago sin haber sido VIP:
  // el usuario pidió: solo si la suscripción ha finalizado → Cancelado
  if (user.estado !== 'Cancelado') {
    await ctx.reply(
      [
        `ℹ️ /borrar_datos solo está disponible cuando tu suscripción VIP ha <b>finalizado</b> y estás en plan gratuito.`,
        ``,
        `Si nunca fuiste VIP, no hace falta: no guardamos datos de pago. Las 3 pruebas de IA ya quedan ligadas a tu cuenta.`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
    return;
  }

  const { limpiarDatosUsuarioConservandoId } = await import('../db/queries');
  const result = await limpiarDatosUsuarioConservandoId(telegramId);
  if (result.ok) {
    logger.info(
      `🗑️ Usuario ${telegramId} purgó datos (msgs=${result.mensajesBorrados}); ID conservado.`
    );
    await ctx.reply(
      [
        `✅ Datos personales eliminados.`,
        ``,
        `Se han quitado filtros, email y mensajes VIP con enlace (${result.mensajesBorrados} mensaje(s)).`,
        `Tu ID de Telegram se conserva: no podrás volver a usar las 3 pruebas gratis de la IA si ya las consumiste.`,
        ``,
        `Puedes seguir en plan gratuito o hacerte VIP de nuevo con /start.`,
      ].join('\n')
    );
  } else {
    await ctx.reply('Ha ocurrido un error al limpiar tus datos. Por favor contacta con soporte.');
  }
}

// ------------------------------------------------------------
// Mensaje de bienvenida
// ------------------------------------------------------------

export async function getActivePaymentLink(): Promise<string> {
  const { getCountUsuariosVIPActivos } = await import('../db/queries');
  const cobrados = await getCountUsuariosVIPActivos();

  const tier1Max = parseInt(process.env['STRIPE_TIER1_MAX'] ?? '200', 10);
  const tier2Max = parseInt(process.env['STRIPE_TIER2_MAX'] ?? '1000', 10);

  let link = '';
  if (cobrados <= tier1Max) {
    // 0 … 200
    link = process.env['STRIPE_PAYMENT_LINK_TIER1'] ?? '';
  } else if (cobrados <= tier2Max) {
    // 201 … 1000
    link = process.env['STRIPE_PAYMENT_LINK_TIER2'] ?? '';
  } else {
    // > 1000
    link = process.env['STRIPE_PAYMENT_LINK_TIER3'] ?? '';
  }

  return link;
}

export async function enviarMensajeBienvenida(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;

  const resultado = await registrarUsuario(telegramId);
  if (resultado === 'nuevo') {
    logger.info(`👤 Usuario ${telegramId} registrado (nuevo)`);
  }

  const paymentLink = await getActivePaymentLink();
  const urlPago = paymentLink
    ? `${paymentLink}?client_reference_id=${telegramId}`
    : '#';

  const billingPortalLink = process.env['STRIPE_BILLING_PORTAL_URL'] ?? '#';

  let publicChannelLink = process.env['TELEGRAM_CHANNEL_PUBLICO_ID'];

  if (publicChannelLink && !publicChannelLink.startsWith('http')) {
    const link = await generarEnlacePublicoPermanente(publicChannelLink);
    if (link) {
      publicChannelLink = link;
    } else {
      publicChannelLink = `https://t.me/${publicChannelLink.replace('@', '')}`;
    }
  }

  const user = await getUsuarioPorTelegramId(telegramId);
  const esVIP = user?.estado === 'Pagado' || user?.estado === 'Cancelando';

  const texto = [
    `🚨 <b>¡Bienvenido a Alertas VIP Subastas!</b>`,
    ``,
    `Rastreamos <b>vehículos embargados</b> en el BOE y portales privados (Escrapalia, eActivos, Procuradores) y te avisamos sin ruido.`,
    ``,
    `🆓 <b>Canal público</b>`,
    `<blockquote>Pocas alertas al día, solo cuando faltan &lt;24 h para el cierre.\nVes el vehículo, pero <b>sin el enlace</b> a la subasta.</blockquote>`,
    ``,
    `🤖 <b>Asesor IA</b>`,
    `<blockquote>Consejo de pujas/riesgos, recuperar subastas perdidas y alternativa si un enlace cae.\n\nPlan gratuito: <b>${AI_FREE_MAX} mensajes</b> · VIP: hasta ${AI_VIP_DAILY_MAX}/día.\nUsa /asesor para ver ejemplos.</blockquote>`,
    ``,
    `💎 <b>VIP</b>`,
    `<blockquote>Configuras tu radar (<b>marca, modelo, comunidad y puja máxima</b>) y recibes resúmenes con el <b>enlace</b> a cada subasta.\nEliges <b>días, horas e intervalo</b> con /horario (por defecto cada 2 h, 08:00–21:00).\nAdemás, más uso del asesor IA.</blockquote>`,
    ``,
    `⌨️ <b>Comandos útiles</b>`,
    `<blockquote>/start — este menú\n/filtros — radar VIP\n/horario — días, horas e intervalo de resúmenes\n/asesor — cómo usar la IA\n/estado — tu suscripción\n/borrar_datos — limpiar datos VIP (solo cuando el VIP ha terminado)</blockquote>`,
    ``,
    `👇 <i>Elige una opción, un comando o escribe al asesor:</i>`,
  ].join('\n');

  const botones = [];
  if (publicChannelLink) {
    botones.push([Markup.button.url('🆓 Entrar al canal público', publicChannelLink)]);
  }

  if (!esVIP) {
    botones.push([Markup.button.url('💎 Hacerme VIP', urlPago)]);
  }

  botones.push([Markup.button.callback('📋 Ver mi estado', 'ver_estado')]);
  
  // Botón legal
  const legalUrl = 'https://drive.google.com/file/d/1bvrTFHAeF_tJroPTItDrdlWxVNmaVWd2/view?usp=sharing';
  botones.push([Markup.button.url('📄 Política de privacidad y términos', legalUrl)]);

  if (esVIP) {
    botones.push([Markup.button.callback('⚙️ Configurar radar VIP', 'configurar_filtros')]);
    botones.push([Markup.button.callback('⏰ Horario de resúmenes', 'vip_horario')]);
    botones.push([Markup.button.url('💳 Gestionar mi suscripción', billingPortalLink)]);
  }

  try {
    await ctx.reply(texto, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: botones },
    });
  } catch (error) {
    logger.error('❌ Error enviando mensaje de bienvenida:', { error });
  }
}

/**
 * Envia de forma automática el panel VIP interactivo al usuario inmediatamente tras confirmar el pago en Stripe.
 */
export async function enviarPanelVIPInicial(telegramId: string, email?: string): Promise<void> {
  const botInstance = getTelegramBot();
  const billingPortalLink = process.env['STRIPE_BILLING_PORTAL_URL'] ?? '#';

  const texto = [
    `🎉 <b>¡Suscripción VIP activada!</b>`,
    ``,
    `Hemos procesado tu pago correctamente${email ? ` (<code>${email}</code>)` : ''}.`,
    ``,
    `🏎️ <b>Activa tu radar</b>`,
    ``,
    `Para recibir resúmenes configura <b>marca → modelo → Comunidad Autónoma → puja</b>. Solo verás opciones con stock real.`,
    ``,
    `Con <b>/horario</b> eliges días, horas e intervalo de los resúmenes (por defecto cada 2 h, 08:00–21:00 Madrid).`,
    ``,
    `El <b>asesor IA</b>: hasta ${AI_VIP_DAILY_MAX} mensajes/día y ${AI_VIP_WEEKLY_MAX}/semana. Escríbeme aquí en castellano.`,
    ``,
    `👇 <b>Empieza aquí:</b>`,
  ].join('\n');

  const botones = [
    [Markup.button.callback('⚙️ Configurar radar VIP', 'configurar_filtros')],
    [Markup.button.callback('⏰ Horario de resúmenes', 'vip_horario')],
    [Markup.button.callback('📋 Ver mi estado', 'ver_estado')],
    [Markup.button.url('💳 Gestionar mi suscripción', billingPortalLink)]
  ];

  try {
    await botInstance.telegram.sendMessage(telegramId, texto, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: botones },
    });
  } catch (error) {
    logger.error('❌ Error enviando panel VIP inicial tras pago:', { error });
  }
}

// ------------------------------------------------------------
// Inicialización y cierre
// ------------------------------------------------------------

export async function iniciarBot(): Promise<void> {
  const botInstance = getTelegramBot();
  const { getAdminChatId, getAdminUserIds } = await import('../utils/admin');

  const userCommands = [
    { command: 'start', description: 'Inicio y bienvenida' },
    { command: 'filtros', description: 'Configurar radar VIP' },
    { command: 'horario', description: 'Horario de resúmenes VIP' },
    { command: 'asesor', description: 'Cómo usar el asesor IA' },
    { command: 'estado', description: 'Estado de suscripción' },
    { command: 'borrar_datos', description: 'Limpiar datos (solo post-VIP)' },
  ];

  const adminOnlyCommands = [
    { command: 'vip_count', description: 'Contador VIP en tiempo real' },
    { command: 'get_topic_id', description: 'Obtener CHAT_ID / TOPIC_ID' },
    { command: 'help', description: 'Lista comandos admin' },
  ];

  const adminMenu = [...userCommands, ...adminOnlyCommands];

  await botInstance.telegram.setMyCommands(userCommands);
  await botInstance.telegram
    .deleteMyCommands({ scope: { type: 'all_group_chats' } })
    .catch(() => {});

  const adminChat = getAdminChatId();
  if (adminChat) {
    const chatId = Number(adminChat);
    if (Number.isFinite(chatId)) {
      await botInstance.telegram.setMyCommands(adminMenu, {
        scope: { type: 'chat', chat_id: chatId },
      });
      // Admins del chat/canal: Telegram muestra mejor el menú con este scope
      await botInstance.telegram
        .setMyCommands(adminMenu, {
          scope: { type: 'chat_administrators', chat_id: chatId },
        })
        .catch((e) =>
          logger.warn(`setMyCommands chat_administrators: ${(e as Error).message}`)
        );
      logger.info(`📋 Menú admin registrado en chat ${chatId}`);
    }
  }

  for (const uid of getAdminUserIds()) {
    const id = Number(uid);
    if (!Number.isFinite(id)) continue;
    await botInstance.telegram.setMyCommands(adminMenu, {
      scope: { type: 'chat', chat_id: id },
    });
  }

  logger.info('🤖 Iniciando bot de Telegram (long polling)...');
  await botInstance.launch({
    allowedUpdates: [
      'message',
      'callback_query',
      'channel_post',
      'my_chat_member',
      'chat_member',
    ],
  });
  logger.info('✅ Bot de Telegram activo.');

  // Aviso en canal admin: el menú “/” de canales suele estar vacío
  if (adminChat) {
    setTimeout(async () => {
      try {
        const chat = await botInstance.telegram.getChat(adminChat);
        if (chat.type === 'channel') {
          logger.warn(
            '⚠️ TELEGRAM_ADMIN_CHAT_ID es un CANAL. Los comandos llegan como channel_post; el menú “/” casi no lista bots. Escribe /vip_count o /help a mano, o usa un grupo privado.'
          );
          await botInstance.telegram.sendMessage(
            adminChat,
            [
              `🛠 <b>Admin Subastas — comandos</b>`,
              ``,
              `Este chat es un <b>canal</b>: Telegram no muestra bien el menú de bots.`,
              `Escribe a mano:`,
              ``,
              `<code>/vip_count</code> — contador VIP`,
              `<code>/help</code> — lista completa`,
              `<code>/get_topic_id</code> — CHAT_ID`,
              ``,
              `<i>Recomendado: grupo privado admin para menú “/” completo.</i>`,
            ].join('\n'),
            { parse_mode: 'HTML', disable_notification: true }
          );
        }
      } catch (e) {
        logger.warn(`aviso canal admin: ${(e as Error).message}`);
      }
    }, 8_000);
  }
}

export async function detenerBot(): Promise<void> {
  if (bot) {
    bot.stop('SIGTERM');
    logger.info('🛑 Bot de Telegram detenido.');
  }
}
