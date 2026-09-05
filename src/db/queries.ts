import { prisma } from './prisma';
import { logger } from '../services/logger';
import { procesarVehiculo } from '../services/sanitizer';
import type { Vehiculo, VehiculoDB, EstadoUsuario, UsuarioVIP } from '../types';

// ============================================================
// QUERIES — Funciones de acceso a datos mediante Prisma ORM
// Alertas VIP Subastas
// ============================================================

// ------------------------------------------------------------
// Vehículos
// ------------------------------------------------------------

/**
 * Comprueba si un vehículo ya existe en la BD.
 * Sin idLote: cualquier lote de esa subasta+portal (útil para saltar detalles).
 */
export async function existeVehiculo(idSubasta: string, portal: string, idLote?: string): Promise<boolean> {
  const count = await prisma.vehiculo.count({
    where:
      idLote !== undefined
        ? { id_subasta: idSubasta, id_lote: idLote, portal }
        : { id_subasta: idSubasta, portal },
  });
  return count > 0;
}

export async function existeVehiculoPorEnlace(enlace: string): Promise<boolean> {
  const count = await prisma.vehiculo.count({
    where: { enlace }
  });
  return count > 0;
}

/**
 * Inserta o actualiza un vehículo del BOE o portales privados.
 * Si ya existe (mismo id_subasta + id_lote + portal), actualiza los campos económicos.
 * Devuelve 'nuevo' si se insertó, 'actualizado' si se actualizó, 'duplicado' si no cambió nada.
 */
export async function upsertVehiculo(vRaw: Vehiculo): Promise<'nuevo' | 'actualizado' | 'duplicado'> {
  const v = procesarVehiculo(vRaw);
  const lote = v.id_lote ?? '';
  const portal = v.portal;

  const existente = await prisma.vehiculo.findUnique({
    where: {
      id_subasta_id_lote_portal: {
        id_subasta: v.id_subasta,
        id_lote: lote,
        portal: portal
      }
    },
    select: { puja_minima: true, marcaNorm: true, ccaaNorm: true }
  });

  if (!existente) {
    // Comprobación de Duplicado Semántico Cruzado (entre portales diferentes)
    if (v.provincia && v.marca && v.modelo) {
      const duplicadoSemantico = await prisma.vehiculo.findFirst({
        where: {
          portal: { not: portal },
          marca: v.marca,
          modelo: v.modelo,
          provincia: v.provincia,
          puja_minima: v.puja_minima
        },
        select: { id_subasta: true }
      });

      if (duplicadoSemantico) {
        logger.warn(`♻️ [Filtro] Vehículo duplicado cruzado bloqueado: ${v.marca} ${v.modelo} en ${v.provincia}`);
        return 'duplicado';
      }
    }

    await prisma.vehiculo.create({
      data: {
        id_subasta: v.id_subasta,
        id_lote: lote,
        portal: portal,
        enlace: v.enlace,
        titulo: v.titulo,
        marca: v.marca,
        modelo: v.modelo,
        marcaNorm: v.marcaNorm,
        modeloNorm: v.modeloNorm,
        versionTokens: v.versionTokens,
        ccaaNorm: v.ccaaNorm,
        puja_minima: v.puja_minima,
        fecha_inicio: v.fecha_inicio ?? null,
        fecha_fin: v.fecha_fin ? new Date(v.fecha_fin) : null,
        provincia: v.provincia ?? null,
        comunidad_autonoma: v.comunidad_autonoma ?? null
      }
    });
    return 'nuevo';
  }

  const needsNorms = !existente.marcaNorm || !existente.ccaaNorm;
  const pujaChanged = existente.puja_minima !== v.puja_minima;
  if (!pujaChanged && !needsNorms) {
    return 'duplicado';
  }

  await prisma.vehiculo.update({
    where: {
      id_subasta_id_lote_portal: {
        id_subasta: v.id_subasta,
        id_lote: lote,
        portal: portal
      }
    },
    data: {
      enlace: v.enlace,
      titulo: v.titulo,
      marca: v.marca,
      modelo: v.modelo,
      marcaNorm: v.marcaNorm,
      modeloNorm: v.modeloNorm,
      versionTokens: v.versionTokens,
      ccaaNorm: v.ccaaNorm,
      puja_minima: v.puja_minima,
      fecha_inicio: v.fecha_inicio ?? null,
      fecha_fin: v.fecha_fin ? new Date(v.fecha_fin) : null,
      provincia: v.provincia ?? null,
      comunidad_autonoma: v.comunidad_autonoma ?? null,
      // Título/marca cambiaron → re-revisar en job de limpieza
      revisado: false,
    }
  });
  return pujaChanged ? 'actualizado' : 'duplicado';
}

/**
 * Inserta un lote de vehículos.
 */
export async function upsertVehiculosLote(vehiculos: Vehiculo[]): Promise<{ nuevo: number; actualizado: number; duplicado: number }> {
  const stats = { nuevo: 0, actualizado: 0, duplicado: 0 };
  for (const v of vehiculos) {
    const res = await upsertVehiculo(v);
    stats[res]++;
  }
  return stats;
}

/**
 * Obtiene vehículos que NO han sido evaluados ni notificados al usuario VIP indicado.
 */
export async function getVehiculosParaVIPUsuario(telegramId: string, limite: number = 10): Promise<VehiculoDB[]> {
  const rows = await prisma.vehiculo.findMany({
    where: {
      notificaciones: {
        none: { telegram_id: telegramId }
      },
      OR: [
        { fecha_fin: null },
        { fecha_fin: { gt: new Date() } }
      ]
    },
    orderBy: { created_at: 'asc' },
    take: limite
  });

  return rows.map((r: any) => ({
    ...r,
    fecha_inicio: r.fecha_inicio ?? '',
    fecha_fin: r.fecha_fin ? r.fecha_fin.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString()
  })) as any[];
}

/**
 * Registra una notificación como evaluada/enviada para un usuario VIP concreto.
 */
export async function registrarNotificacionVIPEnviada(
  telegramId: string,
  idSubasta: string,
  idLote: string | undefined,
  portal: string,
  messageId: number = 0
): Promise<void> {
  const lote = idLote ?? '';
  await prisma.notificacionVIPEnviada.upsert({
    where: {
      telegram_id_id_subasta_id_lote_portal: {
        telegram_id: telegramId,
        id_subasta: idSubasta,
        id_lote: lote,
        portal: portal
      }
    },
    create: {
      telegram_id: telegramId,
      id_subasta: idSubasta,
      id_lote: lote,
      portal: portal,
      telegram_message_id: messageId
    },
    update: {
      telegram_message_id: messageId
    }
  });
}

/**
 * Obtiene vehículos que NO han sido publicados en el grupo VIP (deprecado, se usa por compatibilidad).
 */
export async function getVehiculosParaVIP(limite: number = 10): Promise<VehiculoDB[]> {
  const rows = await prisma.vehiculo.findMany({
    where: {
      publicado_vip: false,
      OR: [
        { fecha_fin: null },
        { fecha_fin: { gt: new Date(Date.now() + 24 * 60 * 60 * 1000) } }
      ]
    },
    orderBy: { created_at: 'asc' },
    take: limite
  });

  return rows.map((r: any) => ({
    ...r,
    fecha_inicio: r.fecha_inicio ?? '',
    fecha_fin: r.fecha_fin ? r.fecha_fin.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString()
  })) as any[];
}

/**
 * Cuenta cuántos vehículos se han publicado en el canal público en las últimas 24 horas.
 */
export async function getPublicacionesPublicasHoyCount(): Promise<number> {
  const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return await prisma.vehiculo.count({
    where: {
      publicado_publico: true,
      updated_at: {
        gte: hace24h
      }
    }
  });
}

/**
 * Obtiene vehículos que NO han sido publicados en Público y caducan en menos de 24h.
 */
export async function getVehiculosParaPublico(limite: number = 10): Promise<VehiculoDB[]> {
  const hace3h = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const en24h = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const rows = await prisma.vehiculo.findMany({
    where: {
      publicado_publico: false,
      fecha_fin: {
        gt: hace3h,
        lte: en24h
      }
    },
    orderBy: { fecha_fin: 'asc' },
    take: limite
  });

  return rows.map((r: any) => ({
    ...r,
    fecha_inicio: r.fecha_inicio ?? '',
    fecha_fin: r.fecha_fin ? r.fecha_fin.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString()
  })) as any[];
}

/**
 * Marca un vehículo como publicado.
 */
export async function marcarVehiculoComoPublicado(
  idSubasta: string,
  idLote: string | undefined,
  portal: string,
  tipo: 'vip' | 'publico',
  messageId: number
): Promise<boolean> {
  const lote = idLote ?? '';
  try {
    if (tipo === 'vip') {
      await prisma.vehiculo.update({
        where: { id_subasta_id_lote_portal: { id_subasta: idSubasta, id_lote: lote, portal } },
        data: { publicado_vip: true, telegram_message_id_vip: messageId }
      });
    } else {
      await prisma.vehiculo.update({
        where: { id_subasta_id_lote_portal: { id_subasta: idSubasta, id_lote: lote, portal } },
        data: { publicado_publico: true, telegram_message_id_publico: messageId }
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Obtiene estadísticas generales de vehículos en la BD.
 */
export async function getEstadisticasVehiculos() {
  const total = await prisma.vehiculo.count();
  const pendientes = await prisma.vehiculo.count({ where: { publicado_vip: false, publicado_publico: false } });
  const publicadosVIP = await prisma.vehiculo.count({ where: { publicado_vip: true } });

  const porMarcaRaw = await prisma.vehiculo.groupBy({
    by: ['marca'],
    _count: { marca: true },
    orderBy: { _count: { marca: 'desc' } },
    take: 10
  });

  const porMarca = porMarcaRaw.map((item: any) => ({ marca: item.marca, cantidad: item._count.marca }));
  return { total, pendientes, publicadosVIP, porMarca };
}

/**
 * Obtiene el número de vehículos actualmente activos (no caducados) y publicados
 * en el canal VIP, agrupados por su Comunidad Autónoma.
 */
export async function getRecuentoVehiculosActivosPorCCAA(): Promise<Record<string, number>> {
  const rows = await prisma.vehiculo.groupBy({
    by: ['comunidad_autonoma'],
    where: {
      publicado_vip: true,
      OR: [
        { fecha_fin: null },
        { fecha_fin: { gt: new Date() } }
      ]
    },
    _count: { _all: true }
  });

  const recuento: Record<string, number> = {};
  for (const row of (rows as any[])) {
    const ccaa = row.comunidad_autonoma || 'General';
    recuento[ccaa] = row._count._all;
  }
  return recuento;
}

/**
 * Obtiene subastas que expiraron (fecha_fin) hace más de N horas y siguen publicadas en Telegram.
 */
export async function getVehiculosParaBorrarTelegram(horasAntiguedad: number): Promise<VehiculoDB[]> {
  const fechaLimite = new Date(Date.now() - horasAntiguedad * 60 * 60 * 1000);
  const rows = await prisma.vehiculo.findMany({
    where: {
      OR: [
        { telegram_message_id_publico: { not: null } },
        { telegram_message_id_vip: { not: null } }
      ],
      AND: [
        {
          OR: [
            { fecha_fin: { lt: fechaLimite } },
            { fecha_fin: null, created_at: { lt: fechaLimite } }
          ]
        }
      ]
    }
  });

  return rows.map((r: any) => ({
    ...r,
    fecha_inicio: r.fecha_inicio ?? '',
    fecha_fin: r.fecha_fin ? r.fecha_fin.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString()
  })) as any[];
}

/**
 * Marca el mensaje de Telegram como borrado (quita el ID para no reintentarlo).
 */
export async function marcarMensajeTelegramBorrado(idSubasta: string, idLote: string | undefined, portal: string): Promise<void> {
  const lote = idLote ?? '';
  try {
    await prisma.vehiculo.update({
      where: { id_subasta_id_lote_portal: { id_subasta: idSubasta, id_lote: lote, portal } },
      data: {
        telegram_message_id_publico: null,
        telegram_message_id_vip: null
      }
    });
  } catch {}
}

/**
 * Elimina físicamente los vehículos antiguos de la base de datos.
 */
export async function eliminarVehiculosBD(diasInactivo: number): Promise<number> {
  const fechaLimite = new Date(Date.now() - diasInactivo * 24 * 60 * 60 * 1000);
  const result = await prisma.vehiculo.deleteMany({
    where: {
      updated_at: { lt: fechaLimite }
    }
  });
  return result.count;
}

// ------------------------------------------------------------
// Usuarios VIP
// ------------------------------------------------------------

/**
 * Registra un nuevo usuario o devuelve 'existente' si ya está registrado.
 */
export async function registrarUsuario(telegramId: string): Promise<'nuevo' | 'existente'> {
  const existe = await prisma.usuarioVIP.findUnique({
    where: { telegram_id: telegramId }
  });

  if (existe) return 'existente';

  await prisma.usuarioVIP.create({
    data: { telegram_id: telegramId }
  });
  return 'nuevo';
}

/**
 * Obtiene un usuario por su telegram_id.
 */
export async function getUsuarioPorTelegramId(telegramId: string): Promise<UsuarioVIP | null> {
  const row = await prisma.usuarioVIP.findUnique({
    where: { telegram_id: telegramId }
  });
  if (!row) return null;
  return {
    ...row,
    email: row.email ?? undefined,
    stripe_customer_id: row.stripe_customer_id ?? undefined,
    estado: row.estado as EstadoUsuario,
    ai_pruebas_usadas: (row as any).ai_pruebas_usadas ?? 0,
    created_at: row.created_at.toISOString(),
    cancel_at: row.cancel_at ? row.cancel_at.toISOString() : undefined
  };
}

const AI_PRUEBAS_MAX = 3;

/** Chat VIP diario/semanal (varios proyectos → tope moderado). */
export const AI_VIP_DAILY_MAX = Math.max(1, parseInt(process.env['AI_VIP_DAILY_MAX'] ?? '20', 10));
export const AI_VIP_WEEKLY_MAX = Math.max(1, parseInt(process.env['AI_VIP_WEEKLY_MAX'] ?? '140', 10));
export const AI_FREE_MAX = AI_PRUEBAS_MAX;

/** VIP: recuperar lote perdido con ficha+enlace (solo cuenta si hay anuncio). */
export const AI_AD_RECOVERY_DAILY_MAX = Math.max(
  0,
  parseInt(process.env['AI_INVENTORY_DAILY_MAX'] ?? process.env['AI_AD_RECOVERY_DAILY_MAX'] ?? '3', 10)
);
/** VIP: alternativa por enlace caído (1/día, solo si hay anuncio). */
export const AI_BROKEN_LINK_DAILY_MAX = Math.max(
  0,
  parseInt(process.env['AI_BROKEN_LINK_DAILY_MAX'] ?? '1', 10)
);
/** Free: 1 ficha de recuperación sin enlace. */
export const AI_AD_RECOVERY_DAILY_MAX_FREE = Math.max(
  0,
  parseInt(process.env['AI_INVENTORY_DAILY_MAX_FREE'] ?? '1', 10)
);

export type TipoRecuperacionFicha = 'enlace_roto' | 'recuperacion';

function aiVipDailyMax(): number {
  return AI_VIP_DAILY_MAX;
}

function aiVipWeeklyMax(): number {
  return AI_VIP_WEEKLY_MAX;
}

/** @deprecated usar AI_AD_RECOVERY_* — alias legacy. */
function aiInventoryDailyMax(esVip: boolean): number {
  return esVip ? AI_AD_RECOVERY_DAILY_MAX : AI_AD_RECOVERY_DAILY_MAX_FREE;
}

/** Claves de cupo en zona Europe/Madrid */
function clavesAiMadrid(now = new Date()): { dia: string; semana: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dia = fmt.format(now); // YYYY-MM-DD
  // Lunes de la semana ISO en Madrid: restar (dow+6)%7 días
  const parts = dia.split('-').map(Number);
  const y = parts[0]!,
    m = parts[1]!,
    d = parts[2]!;
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = utcNoon.getUTCDay(); // 0=domingo
  const toMonday = (dow + 6) % 7;
  utcNoon.setUTCDate(utcNoon.getUTCDate() - toMonday);
  const semana = fmt.format(utcNoon);
  return { dia, semana };
}

export type AccesoIA =
  | { ok: true; restantes: number; esVip: boolean; motivo?: undefined }
  | { ok: false; restantes: number; esVip: boolean; motivo: 'freemium' | 'diario' | 'semanal' };

/** Freemium: 3 pruebas. VIP: máx. diario + semanal (env). */
export async function puedeUsarIA(telegramId: string): Promise<AccesoIA> {
  let user = await getUsuarioPorTelegramId(telegramId);
  if (!user) {
    await registrarUsuario(telegramId);
    user = await getUsuarioPorTelegramId(telegramId);
  }
  const esVip = user?.estado === 'Pagado' || user?.estado === 'Cancelando';

  if (!esVip) {
    const usadas = user?.ai_pruebas_usadas ?? 0;
    const restantes = Math.max(0, AI_PRUEBAS_MAX - usadas);
    if (restantes <= 0) return { ok: false, restantes: 0, esVip: false, motivo: 'freemium' };
    return { ok: true, restantes, esVip: false };
  }

  const dailyMax = aiVipDailyMax();
  const weeklyMax = aiVipWeeklyMax();
  const { dia, semana } = clavesAiMadrid();

  const row = await prisma.usuarioVIP.findUnique({
    where: { telegram_id: telegramId },
    select: {
      ai_uso_diario: true,
      ai_uso_semanal: true,
      ai_clave_dia: true,
      ai_clave_semana: true,
    },
  });

  let usoDia = row?.ai_clave_dia === dia ? (row.ai_uso_diario ?? 0) : 0;
  let usoSemana = row?.ai_clave_semana === semana ? (row.ai_uso_semanal ?? 0) : 0;

  if (usoDia >= dailyMax) {
    return { ok: false, restantes: 0, esVip: true, motivo: 'diario' };
  }
  if (usoSemana >= weeklyMax) {
    return { ok: false, restantes: 0, esVip: true, motivo: 'semanal' };
  }

  const restDia = dailyMax - usoDia;
  const restSem = weeklyMax - usoSemana;
  return { ok: true, restantes: Math.min(restDia, restSem), esVip: true };
}

export async function consumirPruebaIA(telegramId: string): Promise<number> {
  const row = await prisma.usuarioVIP.update({
    where: { telegram_id: telegramId },
    data: { ai_pruebas_usadas: { increment: 1 } },
    select: { ai_pruebas_usadas: true },
  });
  return Math.max(0, AI_PRUEBAS_MAX - row.ai_pruebas_usadas);
}

/** Incrementa cupo VIP diario/semanal; devuelve mensajes restantes (mín. día/semana). */
export async function consumirUsoIAVip(telegramId: string): Promise<number> {
  const dailyMax = aiVipDailyMax();
  const weeklyMax = aiVipWeeklyMax();
  const { dia, semana } = clavesAiMadrid();

  const actual = await prisma.usuarioVIP.findUnique({
    where: { telegram_id: telegramId },
    select: {
      ai_uso_diario: true,
      ai_uso_semanal: true,
      ai_clave_dia: true,
      ai_clave_semana: true,
    },
  });

  const usoDia = actual?.ai_clave_dia === dia ? (actual.ai_uso_diario ?? 0) + 1 : 1;
  const usoSemana = actual?.ai_clave_semana === semana ? (actual.ai_uso_semanal ?? 0) + 1 : 1;

  await prisma.usuarioVIP.update({
    where: { telegram_id: telegramId },
    data: {
      ai_uso_diario: usoDia,
      ai_uso_semanal: usoSemana,
      ai_clave_dia: dia,
      ai_clave_semana: semana,
    },
  });

  return Math.min(Math.max(0, dailyMax - usoDia), Math.max(0, weeklyMax - usoSemana));
}

export type AccesoInventarioIA =
  | { ok: true; restantes: number }
  | { ok: false; restantes: 0 };

async function lecturaCupoInventario(
  telegramId: string,
  esVip: boolean
): Promise<{ uso: number; max: number; dia: string }> {
  const max = aiInventoryDailyMax(esVip);
  const { dia } = clavesAiMadrid();
  const actual = await prisma.usuarioVIP.findUnique({
    where: { telegram_id: telegramId },
    select: { ai_inv_uso_diario: true, ai_inv_clave_dia: true },
  });
  const uso = actual?.ai_inv_clave_dia === dia ? (actual.ai_inv_uso_diario ?? 0) : 0;
  return { uso, max, dia };
}

/** ¿Queda cupo de recuperación de lote hoy? (sin consumir) */
export async function puedeConsultarInventarioIA(
  telegramId: string,
  esVip: boolean
): Promise<AccesoInventarioIA> {
  const { uso, max } = await lecturaCupoInventario(telegramId, esVip);
  if (max <= 0 || uso >= max) return { ok: false, restantes: 0 };
  return { ok: true, restantes: max - uso };
}

/**
 * Consume 1 recuperación de lote del día (Europa/Madrid).
 * Llamar solo tras entregar ficha (VIP con enlace, o free sin enlace).
 */
export async function consumirConsultaInventarioIA(
  telegramId: string,
  esVip: boolean
): Promise<AccesoInventarioIA> {
  const { uso, max, dia } = await lecturaCupoInventario(telegramId, esVip);
  if (max <= 0 || uso >= max) return { ok: false, restantes: 0 };

  const nuevo = uso + 1;
  await prisma.usuarioVIP.update({
    where: { telegram_id: telegramId },
    data: { ai_inv_uso_diario: nuevo, ai_inv_clave_dia: dia },
  });
  return { ok: true, restantes: Math.max(0, max - nuevo) };
}

export interface RecoveryQuotaStatus {
  permitido: boolean;
  tipo: TipoRecuperacionFicha;
  usadoHoy: number;
  maxHoy: number;
  restanteHoy: number;
  motivo?: string;
}

async function lecturaCupoRecuperacion(
  telegramId: string,
  tipo: TipoRecuperacionFicha
): Promise<{ uso: number; max: number; dia: string; esVip: boolean }> {
  const { dia } = clavesAiMadrid();
  const max = tipo === 'enlace_roto' ? AI_BROKEN_LINK_DAILY_MAX : AI_AD_RECOVERY_DAILY_MAX;
  const row = await prisma.usuarioVIP.findUnique({
    where: { telegram_id: telegramId },
    select: {
      estado: true,
      ai_inv_uso_diario: true,
      ai_inv_clave_dia: true,
      ai_broken_uso_diario: true,
    },
  });
  const esVip = row?.estado === 'Pagado' || row?.estado === 'Cancelando';
  const mismoDia = row?.ai_inv_clave_dia === dia;
  const uso = !mismoDia
    ? 0
    : tipo === 'enlace_roto'
      ? (row?.ai_broken_uso_diario ?? 0)
      : (row?.ai_inv_uso_diario ?? 0);
  return { uso, max, dia, esVip };
}

/** Cupo VIP ficha+enlace: enlace roto (1/día) o recuperación (3/día). */
export async function getRecoveryQuotaStatus(
  telegramId: string,
  tipo: TipoRecuperacionFicha
): Promise<RecoveryQuotaStatus> {
  const { uso, max, esVip } = await lecturaCupoRecuperacion(telegramId, tipo);
  if (!esVip) {
    return {
      permitido: false,
      tipo,
      usadoHoy: 0,
      maxHoy: max,
      restanteHoy: 0,
      motivo: 'Solo VIP',
    };
  }
  const restanteHoy = Math.max(0, max - uso);
  return {
    permitido: restanteHoy > 0,
    tipo,
    usadoHoy: uso,
    maxHoy: max,
    restanteHoy,
    motivo:
      restanteHoy > 0
        ? undefined
        : tipo === 'enlace_roto'
          ? `Ya usaste tu ${max} alternativa por enlace roto de hoy. Se reinicia mañana.`
          : `Has alcanzado el máximo de ${max} recuperaciones con enlace de hoy. Se reinicia mañana.`,
  };
}

/**
 * Consume 1 cupo VIP de recuperación (solo si se entregó ficha + enlace).
 */
export async function incrementRecoveryUsage(
  telegramId: string,
  tipo: TipoRecuperacionFicha
): Promise<RecoveryQuotaStatus> {
  const { uso, max, dia, esVip } = await lecturaCupoRecuperacion(telegramId, tipo);
  if (!esVip || max <= 0 || uso >= max) {
    return getRecoveryQuotaStatus(telegramId, tipo);
  }
  const nuevo = uso + 1;
  const row = await prisma.usuarioVIP.findUnique({
    where: { telegram_id: telegramId },
    select: { ai_inv_clave_dia: true, ai_inv_uso_diario: true, ai_broken_uso_diario: true },
  });
  const mismoDia = row?.ai_inv_clave_dia === dia;
  const invKeep = mismoDia ? (row?.ai_inv_uso_diario ?? 0) : 0;
  const brokenKeep = mismoDia ? (row?.ai_broken_uso_diario ?? 0) : 0;

  await prisma.usuarioVIP.update({
    where: { telegram_id: telegramId },
    data: {
      ai_inv_clave_dia: dia,
      ai_inv_uso_diario: tipo === 'recuperacion' ? nuevo : invKeep,
      ai_broken_uso_diario: tipo === 'enlace_roto' ? nuevo : brokenKeep,
    },
  });
  return {
    permitido: true,
    tipo,
    usadoHoy: nuevo,
    maxHoy: max,
    restanteHoy: Math.max(0, max - nuevo),
  };
}

/**
 * Obtiene un usuario por su stripe_customer_id.
 */
export async function getUsuarioPorCustomerId(customerId: string): Promise<UsuarioVIP | null> {
  const row = await prisma.usuarioVIP.findUnique({
    where: { stripe_customer_id: customerId }
  });
  if (!row) return null;
  return {
    ...row,
    email: row.email ?? undefined,
    stripe_customer_id: row.stripe_customer_id ?? undefined,
    estado: row.estado as EstadoUsuario,
    created_at: row.created_at.toISOString(),
    cancel_at: row.cancel_at ? row.cancel_at.toISOString() : undefined
  };
}

/**
 * Obtiene todos los usuarios VIP activos (Pagado o Cancelando con tiempo restante).
 */
export async function getUsuariosVIPActivos(): Promise<UsuarioVIP[]> {
  const rows = await prisma.usuarioVIP.findMany({
    where: {
      OR: [
        { estado: 'Pagado' },
        {
          estado: 'Cancelando',
          OR: [
            { cancel_at: null },
            { cancel_at: { gt: new Date() } }
          ]
        }
      ]
    }
  });

  return rows.map((row: any) => ({
    ...row,
    email: row.email ?? undefined,
    stripe_customer_id: row.stripe_customer_id ?? undefined,
    estado: row.estado as EstadoUsuario,
    created_at: row.created_at.toISOString(),
    cancel_at: row.cancel_at ? row.cancel_at.toISOString() : undefined
  }));
}

/**
 * Obtiene la cuenta total de usuarios VIP activos para el cálculo de Tiers dinámicos.
 */
export async function getCountUsuariosVIPActivos(): Promise<number> {
  return await prisma.usuarioVIP.count({
    where: {
      OR: [
        { estado: 'Pagado' },
        {
          estado: 'Cancelando',
          OR: [
            { cancel_at: null },
            { cancel_at: { gt: new Date() } }
          ]
        }
      ]
    }
  });
}

/**
 * Actualiza el estado de un usuario por su telegram_id.
 */
export async function actualizarEstadoUsuarioPorTelegramId(
  telegramId: string,
  estado: EstadoUsuario,
  email?: string,
  stripeCustomerId?: string
): Promise<void> {
  const data: Record<string, unknown> = { estado };
  if (email) data['email'] = email;
  if (stripeCustomerId) data['stripe_customer_id'] = stripeCustomerId;
  if (estado === 'Cancelado') {
    data['vip_ended_at'] = new Date();
  }
  if (estado === 'Pagado') {
    data['vip_ended_at'] = null;
    data['cancel_at'] = null;
  }

  await prisma.usuarioVIP.update({
    where: { telegram_id: telegramId },
    data
  });
}

/**
 * Actualiza el estado de un usuario por su stripe_customer_id.
 */
export async function actualizarEstadoUsuarioPorCustomerId(
  customerId: string,
  estado: EstadoUsuario
): Promise<UsuarioVIP | null> {
  try {
    const data: Record<string, unknown> = { estado };
    if (estado === 'Cancelado') {
      data['vip_ended_at'] = new Date();
    }
    if (estado === 'Pagado') {
      data['vip_ended_at'] = null;
      data['cancel_at'] = null;
    }

    const updated = await prisma.usuarioVIP.update({
      where: { stripe_customer_id: customerId },
      data
    });
    return {
      ...updated,
      email: updated.email ?? undefined,
      stripe_customer_id: updated.stripe_customer_id ?? undefined,
      estado: updated.estado as EstadoUsuario,
      created_at: updated.created_at.toISOString(),
      cancel_at: updated.cancel_at ? updated.cancel_at.toISOString() : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Reactiva un usuario (estado = 'Pagado' y elimina la fecha de cancelación).
 */
export async function reactivarUsuarioPorCustomerId(
  customerId: string
): Promise<UsuarioVIP | null> {
  try {
    const updated = await prisma.usuarioVIP.update({
      where: { stripe_customer_id: customerId },
      data: { estado: 'Pagado', cancel_at: null, vip_ended_at: null }
    });
    return {
      ...updated,
      email: updated.email ?? undefined,
      stripe_customer_id: updated.stripe_customer_id ?? undefined,
      estado: updated.estado as EstadoUsuario,
      created_at: updated.created_at.toISOString(),
      cancel_at: undefined
    };
  } catch {
    return null;
  }
}

/**
 * Programa la cancelación de un usuario (estado = 'Cancelando').
 */
export async function programarCancelacionUsuarioPorCustomerId(
  customerId: string,
  cancelAt: string
): Promise<UsuarioVIP | null> {
  try {
    const updated = await prisma.usuarioVIP.update({
      where: { stripe_customer_id: customerId },
      data: { estado: 'Cancelando', cancel_at: new Date(cancelAt) }
    });
    return {
      ...updated,
      email: updated.email ?? undefined,
      stripe_customer_id: updated.stripe_customer_id ?? undefined,
      estado: updated.estado as EstadoUsuario,
      created_at: updated.created_at.toISOString(),
      cancel_at: updated.cancel_at ? updated.cancel_at.toISOString() : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Obtiene usuarios cuya suscripción ha expirado hoy (para expulsarlos).
 */
export async function getUsuariosExpiradosParaBorrar(): Promise<UsuarioVIP[]> {
  const rows = await prisma.usuarioVIP.findMany({
    where: {
      estado: 'Cancelando',
      cancel_at: {
        not: null,
        lte: new Date()
      }
    }
  });

  return rows.map((row: any) => ({
    ...row,
    email: row.email ?? undefined,
    stripe_customer_id: row.stripe_customer_id ?? undefined,
    estado: row.estado as EstadoUsuario,
    created_at: row.created_at.toISOString(),
    cancel_at: row.cancel_at ? row.cancel_at.toISOString() : undefined
  }));
}

/**
 * Usuarios Cancelado listos para purga (48h tras vip_ended_at), sin haber purgado aún.
 */
export async function getUsuariosPendientesPurgaDatos(): Promise<UsuarioVIP[]> {
  const horas = Math.max(1, parseInt(process.env['DATA_PURGE_HOURS'] ?? '48', 10));
  const limite = new Date(Date.now() - horas * 3600_000);

  const rows = await prisma.usuarioVIP.findMany({
    where: {
      estado: 'Cancelado',
      datos_purgados_at: null,
      vip_ended_at: { not: null, lte: limite },
    },
  });

  return rows.map((row) => ({
    ...row,
    email: row.email ?? undefined,
    stripe_customer_id: row.stripe_customer_id ?? undefined,
    estado: row.estado as EstadoUsuario,
    created_at: row.created_at.toISOString(),
    cancel_at: row.cancel_at ? row.cancel_at.toISOString() : undefined,
  }));
}

/**
 * Purga datos personales / VIP conservando telegram_id (anti-abuso freemium).
 * - Borra mensajes VIP enviados al chat del usuario
 * - Borra filtros, notificaciones, cola Redis, historial IA en memoria
 * - Quita email / Stripe / radar; deja ai_pruebas_usadas intacto
 * - Pasa a Pendiente_Pago (plan gratuito)
 */
export async function limpiarDatosUsuarioConservandoId(telegramId: string): Promise<{
  ok: boolean;
  mensajesBorrados: number;
}> {
  try {
    const { eliminarMensaje } = await import('../services/telegram.service');
    const { clearUserQueue } = await import('../services/queue.service');
    const { clearAiHistory } = await import('../services/ai.service');

    const notifs = await prisma.notificacionVIPEnviada.findMany({
      where: { telegram_id: telegramId },
      select: { telegram_message_id: true },
    });

    let mensajesBorrados = 0;
    for (const n of notifs) {
      if (n.telegram_message_id > 0) {
        const ok = await eliminarMensaje(telegramId, n.telegram_message_id);
        if (ok) mensajesBorrados++;
      }
    }

    await prisma.notificacionVIPEnviada.deleteMany({ where: { telegram_id: telegramId } });
    await prisma.usuarioFiltros.deleteMany({ where: { telegram_id: telegramId } });
    await clearUserQueue(telegramId);
    clearAiHistory(telegramId);

    try {
      const { clearFilterDraft } = await import('../bot/filters.menu');
      clearFilterDraft(telegramId);
    } catch {
      /* ignore */
    }
    try {
      const { clearHorarioDraft } = await import('../bot/horario.menu');
      clearHorarioDraft(telegramId);
    } catch {
      /* ignore */
    }

    const { defaultDigestPrefs, invalidateDigestPrefsCache } = await import(
      '../services/digest-schedule.service'
    );
    const digDefaults = defaultDigestPrefs();
    await invalidateDigestPrefsCache(telegramId);

    await prisma.usuarioVIP.update({
      where: { telegram_id: telegramId },
      data: {
        email: null,
        stripe_customer_id: null,
        cancel_at: null,
        vip_ended_at: null,
        datos_purgados_at: new Date(),
        estado: 'Pendiente_Pago',
        ai_uso_diario: 0,
        ai_uso_semanal: 0,
        ai_clave_dia: '',
        ai_clave_semana: '',
        ai_inv_uso_diario: 0,
        ai_inv_clave_dia: '',
        ai_broken_uso_diario: 0,
        digest_days: digDefaults.days,
        digest_start_hour: digDefaults.startHour,
        digest_end_hour: digDefaults.endHour,
        digest_interval_h: digDefaults.intervalH,
        // ai_pruebas_usadas se conserva a propósito
      },
    });

    return { ok: true, mensajesBorrados };
  } catch (error) {
    logger.error(`❌ limpiarDatosUsuarioConservandoId(${telegramId}):`, {
      error: (error as Error).message,
    });
    return { ok: false, mensajesBorrados: 0 };
  }
}

/**
 * @deprecated Preferir limpiarDatosUsuarioConservandoId (anti-abuso freemium).
 * No borra la fila: solo limpia datos personales.
 */
export async function eliminarUsuario(telegramId: string): Promise<boolean> {
  const r = await limpiarDatosUsuarioConservandoId(telegramId);
  return r.ok;
}

/**
 * Registra una ejecución del scraper en el log.
 */
export async function registrarEjecucionScraper(
  url: string,
  vehiculosEncontrados: number,
  vehiculosNuevos: number,
  duracionMs: number,
  error?: string
): Promise<void> {
  await prisma.scraperLog.create({
    data: {
      url,
      vehiculos_encontrados: vehiculosEncontrados,
      vehiculos_nuevos: vehiculosNuevos,
      duracion_ms: duracionMs,
      error: error ?? null
    }
  });
}
