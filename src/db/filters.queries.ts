import { prisma } from '../db/prisma';
import type { FiltrosUsuario } from '../types';
import { fingerprintFiltros } from '../utils/normalizer';

export type RadarFiltros = FiltrosUsuario;

export async function getFiltrosUsuario(telegramId: string): Promise<RadarFiltros> {
  const row = await prisma.usuarioFiltros.findUnique({
    where: { telegram_id: telegramId },
  });

  if (!row) {
    return emptyFiltros(telegramId);
  }

  return {
    telegram_id: row.telegram_id,
    tipos: JSON.parse(row.tipos || '[]'),
    comunidades: JSON.parse(row.comunidades || '[]'),
    puja_maxima: row.puja_maxima,
    origenes: JSON.parse(row.origenes || '[]'),
    etiquetas: JSON.parse(row.etiquetas || '[]'),
    estados: JSON.parse(row.estados || '[]'),
    marcaNorm: row.marcaNorm,
    modeloNorm: row.modeloNorm,
    versions: JSON.parse(row.versions || '[]'),
    ccaaNorms: JSON.parse(row.ccaaNorms || '[]'),
    fingerprint: row.fingerprint,
  };
}

function emptyFiltros(telegramId: string): RadarFiltros {
  return {
    telegram_id: telegramId,
    tipos: [],
    comunidades: [],
    puja_maxima: null,
    origenes: [],
    etiquetas: [],
    estados: [],
    marcaNorm: null,
    modeloNorm: null,
    versions: [],
    ccaaNorms: [],
    fingerprint: null,
  };
}

export async function resetEvaluacionesNoEnviadasUsuario(telegramId: string): Promise<void> {
  await prisma.notificacionVIPEnviada.deleteMany({
    where: {
      telegram_id: telegramId,
      telegram_message_id: 0,
    },
  });
}

export async function updateFiltrosUsuario(filtros: RadarFiltros): Promise<void> {
  const fp =
    filtros.fingerprint ||
    fingerprintFiltros({
      marcaNorm: filtros.marcaNorm,
      modeloNorm: filtros.modeloNorm,
      versions: filtros.versions,
      ccaaNorms: filtros.ccaaNorms,
      puja_maxima: filtros.puja_maxima,
    });

  const data = {
    tipos: JSON.stringify(filtros.tipos ?? []),
    comunidades: JSON.stringify(filtros.comunidades ?? []),
    puja_maxima: filtros.puja_maxima,
    origenes: JSON.stringify(filtros.origenes ?? []),
    etiquetas: JSON.stringify(filtros.etiquetas ?? []),
    estados: JSON.stringify(filtros.estados ?? []),
    marcaNorm: filtros.marcaNorm || null,
    modeloNorm: filtros.modeloNorm || null,
    versions: JSON.stringify(filtros.versions ?? []),
    ccaaNorms: JSON.stringify(filtros.ccaaNorms ?? []),
    fingerprint: fp,
  };

  await prisma.usuarioFiltros.upsert({
    where: { telegram_id: filtros.telegram_id },
    create: {
      telegram_id: filtros.telegram_id,
      ...data,
    },
    update: data,
  });

  await resetEvaluacionesNoEnviadasUsuario(filtros.telegram_id);
}

export async function getAllUsuariosFiltros(): Promise<RadarFiltros[]> {
  const rows = await prisma.usuarioFiltros.findMany();
  return rows.map((row) => ({
    telegram_id: row.telegram_id,
    tipos: JSON.parse(row.tipos || '[]'),
    comunidades: JSON.parse(row.comunidades || '[]'),
    puja_maxima: row.puja_maxima,
    origenes: JSON.parse(row.origenes || '[]'),
    etiquetas: JSON.parse(row.etiquetas || '[]'),
    estados: JSON.parse(row.estados || '[]'),
    marcaNorm: row.marcaNorm,
    modeloNorm: row.modeloNorm,
    versions: JSON.parse(row.versions || '[]'),
    ccaaNorms: JSON.parse(row.ccaaNorms || '[]'),
    fingerprint: row.fingerprint,
  }));
}

export function radarIsConfigured(f: RadarFiltros): boolean {
  // Alineado con seed/match: marca, CCAA canónicas o puja (no solo legacy tipos/modelo)
  return Boolean(f.marcaNorm || (f.ccaaNorms && f.ccaaNorms.length) || f.puja_maxima != null);
}
