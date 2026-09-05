import { getVehiculosParaBorrarTelegram, marcarMensajeTelegramBorrado, eliminarVehiculosBD, getUsuariosExpiradosParaBorrar, actualizarEstadoUsuarioPorTelegramId, getUsuariosPendientesPurgaDatos, limpiarDatosUsuarioConservandoId } from '../db/queries';
import { eliminarMensaje, banearUsuario, enviarMensaje } from '../services/telegram.service';
import { logger } from '../services/logger';
import { prisma } from '../db/prisma';
import axios from 'axios';

// ============================================================
// CLEANUP JOB — Mantenimiento de Telegram y Base de Datos
// Alertas VIP Subastas
// ============================================================

/**
 * FASE 1.5: Verificación de Disponibilidad de Enlaces (Limpieza Rápida sin Proxy)
 * Programado para ejecutarse a las 2:00 AM
 */
export async function ejecutarVerificacionEnlacesJob(): Promise<void> {
  logger.info('-'.repeat(50));
  logger.info('🔍 INICIO DE VERIFICACIÓN DE ENLACES ACTIVOS (2 AM)');
  logger.info('-'.repeat(50));

  try {
    const activos = await prisma.vehiculo.findMany({
      where: {
        OR: [
          { fecha_fin: null },
          { fecha_fin: { gte: new Date() } }
        ]
      }
    });

    logger.info(`📋 Encontrados ${activos.length} anuncios activos para verificar.`);
    let enlacesEliminados = 0;

    for (const v of activos) {
      try {
        // HEAD primero (menos ancho de banda); fallback GET corto si el portal rechaza HEAD
        const opts = {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          },
          timeout: 7000,
          maxRedirects: 3,
          validateStatus: (s: number) => s < 500,
        };
        let status = 0;
        try {
          const head = await axios.head(v.enlace, opts);
          status = head.status;
        } catch {
          const get = await axios.get(v.enlace, {
            ...opts,
            maxContentLength: 2048,
            responseType: 'stream',
          });
          status = get.status;
          get.data?.destroy?.();
        }
        if (status === 404) {
          throw Object.assign(new Error('404'), { response: { status: 404 } });
        }
      } catch (err: any) {
        if (err.response && err.response.status === 404) {
          logger.info(`🗑️ Anuncio caído (404) detectado: [${v.portal}] ${v.titulo}. Procediendo a eliminar.`);
          // Borrar de Telegram
          if (v.telegram_message_id_publico) {
            await eliminarMensaje(process.env['TELEGRAM_CHANNEL_PUBLICO_ID'] ?? '', v.telegram_message_id_publico).catch(() => {});
          }
          if (v.telegram_message_id_vip) {
            await eliminarMensaje(process.env['TELEGRAM_GROUP_VIP_ID'] ?? '', v.telegram_message_id_vip).catch(() => {});
          }
          // Borrar físicamente de la base de datos
          await prisma.vehiculo.delete({
            where: {
              id_subasta_id_lote_portal: {
                id_subasta: v.id_subasta,
                id_lote: v.id_lote,
                portal: v.portal
              }
            }
          }).catch(() => {});
          enlacesEliminados++;
        }
        // Cualquier otro código de estado (403, 500, etc.) o error de red / timeout se ignora
      }
      // Evitar saturación al servidor remoto
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    logger.info(`🗑️ Verificación de enlaces finalizada. Se eliminaron ${enlacesEliminados} anuncios no disponibles (404).`);
  } catch (error) {
    logger.error('❌ Error en verificación de enlaces:', { error });
  }
}

/**
 * FASES 1, 2 y 3: Limpieza de Telegram por antigüedad, eliminación de la BD de >30 días y expulsión de usuarios
 * Programado para ejecutarse a las 4:00 AM
 */
export async function ejecutarLimpiezaFisicaJob(): Promise<void> {
  logger.info('-'.repeat(50));
  logger.info('🧹 INICIO DE LIMPIEZA FÍSICA Y USUARIOS EXPIRADOS (4 AM)');
  logger.info('-'.repeat(50));

  const HORAS_TELEGRAM = parseInt(process.env['CLEANUP_HORAS_TELEGRAM'] ?? '48', 10);
  const DIAS_BD = parseInt(process.env['CLEANUP_DIAS_BD'] ?? '30', 10);

  // 1. Limpieza de Telegram
  logger.info(`🔍 Buscando subastas finalizadas hace más de ${HORAS_TELEGRAM} horas en Telegram...`);
  const obsoletos = await getVehiculosParaBorrarTelegram(HORAS_TELEGRAM);

  if (obsoletos.length > 0) {
    logger.info(`🧹 Limpiando ${obsoletos.length} mensajes obsoletos de Telegram...`);
    for (const v of obsoletos) {
      if (v.telegram_message_id_publico) {
        await eliminarMensaje(process.env['TELEGRAM_CHANNEL_PUBLICO_ID'] ?? '', v.telegram_message_id_publico).catch(() => {});
      }
      if (v.telegram_message_id_vip) {
        await eliminarMensaje(process.env['TELEGRAM_GROUP_VIP_ID'] ?? '', v.telegram_message_id_vip).catch(() => {});
      }
      await marcarMensajeTelegramBorrado(v.id_subasta, v.id_lote, v.portal);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // 2. Limpieza Física de la Base de Datos
  logger.info(`🗑️ Eliminando subastas con más de ${DIAS_BD} días de antigüedad en la BD...`);
  const registrosBorrados = await eliminarVehiculosBD(DIAS_BD);

  // 3. Expulsión de Usuarios con Suscripción Finalizada
  logger.info(`👥 Comprobando usuarios cuya suscripción ha expirado...`);
  const usuariosExpirados = await getUsuariosExpiradosParaBorrar();
  let usuariosExpulsados = 0;

  for (const usuario of usuariosExpirados) {
    logger.info(`🚫 Suscripción de ${usuario.telegram_id} ha expirado. Marcando Cancelado.`);

    await actualizarEstadoUsuarioPorTelegramId(usuario.telegram_id, 'Cancelado');

    const channelId = process.env['TELEGRAM_GROUP_VIP_ID'];
    if (channelId) {
      await banearUsuario(usuario.telegram_id, channelId).catch(() => {});
    }

    const horas = process.env['DATA_PURGE_HOURS'] ?? '48';
    await enviarMensaje(
      usuario.telegram_id,
      [
        `<b>🚫 Acceso VIP finalizado</b>`,
        ``,
        `Ya no recibirás resúmenes ni acceso VIP en el bot.`,
        ``,
        `En <b>${horas} h</b> limpiaremos filtros, mensajes con enlace y datos personales.`,
        `Tu ID se conserva para no reiniciar las pruebas gratis de la IA.`,
        `Si quieres adelantarlo: /borrar_datos`,
        ``,
        `¡Gracias! Puedes volver a VIP cuando quieras con /start.`,
      ].join('\n')
    ).catch(() => {});

    usuariosExpulsados++;
  }

  if (usuariosExpulsados > 0) {
    const { refreshVipCounter } = await import('../services/vip-counter.service');
    await refreshVipCounter().catch(() => {});
  }

  // 4. Purga de datos personales 48h tras Cancelado (conserva telegram_id)
  logger.info(`🧹 Comprobando purga de datos post-VIP (${process.env['DATA_PURGE_HOURS'] ?? '48'}h)...`);
  const pendientesPurga = await getUsuariosPendientesPurgaDatos();
  let usuariosPurgados = 0;
  for (const u of pendientesPurga) {
    const r = await limpiarDatosUsuarioConservandoId(u.telegram_id);
    if (r.ok) {
      usuariosPurgados++;
      await enviarMensaje(
        u.telegram_id,
        [
          `<b>🧹 Datos personales limpiados</b>`,
          ``,
          `Hemos eliminado filtros, email y mensajes VIP con enlace.`,
          `Tu cuenta sigue en plan gratuito (mismo ID; las pruebas de IA no se reinician).`,
          `VIP de nuevo cuando quieras: /start`,
        ].join('\n')
      ).catch(() => {});
      logger.info(`✅ Purga OK ${u.telegram_id} (msgs=${r.mensajesBorrados})`);
    }
  }

  logger.info('-'.repeat(50));
  logger.info('✅ CICLO DE LIMPIEZA COMPLETO');
  logger.info(`   Base de Datos: ${registrosBorrados} registros eliminados`);
  logger.info(`   Usuarios: ${usuariosExpulsados} VIP finalizados · ${usuariosPurgados} purgas de datos`);
  logger.info('-'.repeat(50));
}

/**
 * Wrapper general para compatibilidad
 */
export async function ejecutarCleanupJob(): Promise<void> {
  await ejecutarVerificacionEnlacesJob();
  await ejecutarLimpiezaFisicaJob();
}

// Ejecución directa (npm run cleanup)
if (require.main === module) {
  import('dotenv').then(({ config }) => {
    config();
    return ejecutarCleanupJob();
  }).catch(console.error);
}
