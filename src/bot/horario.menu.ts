/**
 * VIP /horario — días, horas e intervalo de digests (Europe/Madrid).
 * Borrador + Listo (escribe UsuarioVIP). Alias: /schedule.
 */
import { Telegraf, Markup, Context } from 'telegraf';
import { getUsuarioPorTelegramId } from '../db/queries';
import {
  ALL_WEEKDAYS,
  WEEKDAYS_ONLY,
  SCHEDULE_START_HOURS,
  SCHEDULE_END_HOURS,
  clampSchedulePrefs,
  formatDigestDays,
  formatHourRange,
  hardStartHour,
  hardEndHour,
  loadDigestPrefs,
  saveDigestPrefs,
  type DigestPrefs,
} from '../services/digest-schedule.service';
import { logger } from '../services/logger';

interface HorarioDraft extends DigestPrefs {
  view?: 'main' | 'days' | 'hours_start' | 'hours_end' | 'interval';
  savedFingerprint?: string;
}

const drafts = new Map<string, HorarioDraft>();

/** Limpia draft en memoria (purga /borrar_datos). */
export function clearHorarioDraft(telegramId: string): void {
  drafts.delete(telegramId);
}

function prefsFingerprint(p: DigestPrefs): string {
  return JSON.stringify({
    days: [...p.days].sort((a, b) => a - b),
    startHour: p.startHour,
    endHour: p.endHour,
    intervalH: p.intervalH,
  });
}

function clonePrefs(p: DigestPrefs): HorarioDraft {
  const base = {
    days: [...p.days],
    startHour: p.startHour,
    endHour: p.endHour,
    intervalH: p.intervalH,
    view: 'main' as const,
  };
  return { ...base, savedFingerprint: prefsFingerprint(base) };
}

function isDraftDirty(draft: HorarioDraft): boolean {
  if (!draft.savedFingerprint) return false;
  return prefsFingerprint(draft) !== draft.savedFingerprint;
}

async function requireVip(telegramId: string): Promise<boolean> {
  const user = await getUsuarioPorTelegramId(telegramId);
  return !!user && (user.estado === 'Pagado' || user.estado === 'Cancelando');
}

async function loadDraft(telegramId: string): Promise<HorarioDraft> {
  let d = drafts.get(telegramId);
  if (!d) {
    d = clonePrefs(clampSchedulePrefs(await loadDigestPrefs(telegramId)));
    drafts.set(telegramId, d);
  }
  return d;
}

function putDraft(telegramId: string, next: HorarioDraft, prev?: HorarioDraft): HorarioDraft {
  const merged: HorarioDraft = {
    ...next,
    savedFingerprint: next.savedFingerprint ?? prev?.savedFingerprint,
  };
  drafts.set(telegramId, merged);
  return merged;
}

function isTelegramNotModifiedError(err: unknown): boolean {
  const desc =
    (err as { response?: { description?: string }; message?: string })?.response?.description ||
    (err as { message?: string })?.message ||
    '';
  return typeof desc === 'string' && desc.includes('message is not modified');
}

async function safeEdit(ctx: Context, text: string, extra?: object) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (!isTelegramNotModifiedError(err)) throw err;
  }
}

async function renderPanel(ctx: Context, telegramId: string, edit: boolean) {
  const draft = await loadDraft(telegramId);

  if (draft.view === 'days') return renderDays(ctx, draft, edit);
  if (draft.view === 'hours_start') return renderHoursStart(ctx, draft, edit);
  if (draft.view === 'hours_end') return renderHoursEnd(ctx, draft, edit);
  if (draft.view === 'interval') return renderInterval(ctx, draft, edit);

  const dirty = isDraftDirty(draft);
  const text = [
    `⏰ <b>Horario de resúmenes</b> (Europe/Madrid)`,
    ``,
    `📅 Días: <b>${formatDigestDays(draft.days)}</b>`,
    `🕐 Horas: <b>${formatHourRange(draft.startHour, draft.endHour)}</b>`,
    `🔁 Cada: <b>${draft.intervalH} h</b>`,
    ``,
    dirty
      ? `⚠️ <b>Cambios sin guardar</b> — pulsa <b>Listo</b> para aplicar.\n`
      : '',
    `<i>Pulsa Listo para guardar. El lote rápido tras filtros respeta este horario.</i>`,
  ]
    .filter(Boolean)
    .join('\n');

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📅 Días', 'horario_view_days'),
      Markup.button.callback('🕐 Horas', 'horario_view_hours_start'),
    ],
    [Markup.button.callback('🔁 Intervalo', 'horario_view_interval')],
    [Markup.button.callback('✅ Listo', 'horario_save')],
  ]);

  if (edit && ctx.callbackQuery) {
    await safeEdit(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  }
}

async function renderDays(ctx: Context, draft: HorarioDraft, edit: boolean) {
  const labels = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const dayBtns = labels.map((label, i) => {
    const day = i + 1;
    const on = draft.days.includes(day);
    return Markup.button.callback(`${on ? '✅' : '⬜'} ${label}`, `horario_day_${day}`);
  });

  const rows = [
    dayBtns.slice(0, 4),
    dayBtns.slice(4),
    [
      Markup.button.callback('L–V', 'horario_days_weekdays'),
      Markup.button.callback('Toda la semana', 'horario_days_all'),
    ],
    [
      Markup.button.callback('🔙 Atrás', 'horario_view_main'),
      Markup.button.callback('✅ Mantener', 'horario_view_main'),
    ],
  ];

  const text = [
    `📅 <b>Elige días</b>`,
    ``,
    `Actual: <b>${formatDigestDays(draft.days)}</b>`,
    ``,
    `<i>Multi-selección. Vacío → toda la semana al guardar.</i>`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    await safeEdit(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  }
}

function hourChoiceButtons(selected: number, hours: number[], prefix: string) {
  const btns = hours.map((h) => {
    const mark = h === selected ? '✅ ' : '';
    return Markup.button.callback(`${mark}${String(h).padStart(2, '0')}:00`, `${prefix}${h}`);
  });
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
  return rows;
}

async function renderHoursStart(ctx: Context, draft: HorarioDraft, edit: boolean) {
  const hardStart = hardStartHour();
  const morning = SCHEDULE_START_HOURS.filter((h) => h >= hardStart && h <= 12);
  const rows = hourChoiceButtons(draft.startHour, [...morning], 'horario_start_');
  rows.push([
    Markup.button.callback('🔙 Atrás', 'horario_view_main'),
    Markup.button.callback('✅ Listo', 'horario_hours_start_done'),
  ]);

  const text = [
    `🕐 <b>Hora de inicio</b> (Europe/Madrid)`,
    ``,
    `Ventana actual: <b>${formatHourRange(draft.startHour, draft.endHour)}</b>`,
    `<i>Por defecto 08:00. Elige desde las ${String(hardStart).padStart(2, '0')}:00–12:00 y pulsa Listo.</i>`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    await safeEdit(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  }
}

async function renderHoursEnd(ctx: Context, draft: HorarioDraft, edit: boolean) {
  const hardEnd = hardEndHour();
  const ends = SCHEDULE_END_HOURS.filter((h) => h > draft.startHour && h <= hardEnd);
  const rows = hourChoiceButtons(draft.endHour, ends.length ? ends : [...SCHEDULE_END_HOURS], 'horario_end_');
  rows.push([
    Markup.button.callback('🔙 Atrás', 'horario_view_hours_start'),
    Markup.button.callback('✅ Listo', 'horario_hours_end_done'),
  ]);

  const text = [
    `🕐 <b>Hora de fin</b> (Europe/Madrid)`,
    ``,
    `Ventana actual: <b>${formatHourRange(draft.startHour, draft.endHour)}</b>`,
    `<i>Por defecto 21:00 (exclusiva). Elige hasta ${String(hardEnd).padStart(2, '0')}:00 y pulsa Listo.</i>`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    await safeEdit(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  }
}

async function renderInterval(ctx: Context, draft: HorarioDraft, edit: boolean) {
  const opts = [1, 2, 3, 4];
  const row = opts.map((h) =>
    Markup.button.callback(`${draft.intervalH === h ? '✅ ' : ''}${h} h`, `horario_interval_${h}`)
  );

  const text = [
    `🔁 <b>Intervalo entre resúmenes</b>`,
    ``,
    `Actual: cada <b>${draft.intervalH} h</b>`,
    `<i>Mín. 1 h · Máx. 4 h · Defecto 2 h. Pulsa Listo para confirmar.</i>`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    row,
    [
      Markup.button.callback('🔙 Atrás', 'horario_view_main'),
      Markup.button.callback('✅ Listo', 'horario_interval_done'),
    ],
  ]);

  if (edit) {
    await safeEdit(ctx, text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  }
}

export async function abrirHorario(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return;
  if (!(await requireVip(telegramId))) {
    await ctx.reply(
      '🔒 El horario de resúmenes es exclusivo VIP. Usa /start para suscribirte.'
    );
    return;
  }
  drafts.set(telegramId, clonePrefs(clampSchedulePrefs(await loadDigestPrefs(telegramId))));
  await renderPanel(ctx, telegramId, false);
}

export function setupHorarioMenu(bot: Telegraf): void {
  bot.action('vip_horario', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!(await requireVip(telegramId))) {
      await ctx.answerCbQuery('Solo para VIP.', { show_alert: true });
      return;
    }
    drafts.set(telegramId, clonePrefs(clampSchedulePrefs(await loadDigestPrefs(telegramId))));
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_view_main', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    const clamped = clampSchedulePrefs(d);
    putDraft(telegramId, { ...clamped, view: 'main' }, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_view_days', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.view = 'days';
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_view_hours_start', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.view = 'hours_start';
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_view_hours_end', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.view = 'hours_end';
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_view_interval', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.view = 'interval';
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action(/^horario_day_(\d+)$/, async (ctx) => {
    const day = parseInt(ctx.match?.[1] || '0', 10);
    if (day < 1 || day > 7) {
      await ctx.answerCbQuery();
      return;
    }
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    const idx = d.days.indexOf(day);
    if (idx >= 0) d.days.splice(idx, 1);
    else d.days.push(day);
    d.days.sort((a, b) => a - b);
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_days_weekdays', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.days = [...WEEKDAYS_ONLY];
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery('Lunes–Viernes');
  });

  bot.action('horario_days_all', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.days = [...ALL_WEEKDAYS];
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery('Toda la semana');
  });

  bot.action(/^horario_start_(\d+)$/, async (ctx) => {
    const h = parseInt(ctx.match?.[1] || '', 10);
    const hardStart = hardStartHour();
    if (
      !SCHEDULE_START_HOURS.includes(h as (typeof SCHEDULE_START_HOURS)[number]) ||
      h < hardStart
    ) {
      await ctx.answerCbQuery();
      return;
    }
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.startHour = h;
    if (d.endHour <= h) {
      const ends = SCHEDULE_END_HOURS.filter((x) => x > h);
      d.endHour = ends[0] ?? 21;
    }
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_hours_start_done', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.view = 'hours_end';
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action(/^horario_end_(\d+)$/, async (ctx) => {
    const h = parseInt(ctx.match?.[1] || '', 10);
    if (!SCHEDULE_END_HOURS.includes(h as (typeof SCHEDULE_END_HOURS)[number])) {
      await ctx.answerCbQuery();
      return;
    }
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    if (h <= d.startHour) {
      await ctx.answerCbQuery('La hora de fin debe ser posterior al inicio.', { show_alert: true });
      return;
    }
    d.endHour = h;
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_hours_end_done', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    putDraft(telegramId, { ...clampSchedulePrefs(d), view: 'main' }, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action(/^horario_interval_(\d+)$/, async (ctx) => {
    const h = parseInt(ctx.match?.[1] || '', 10);
    if (![1, 2, 3, 4].includes(h)) {
      await ctx.answerCbQuery();
      return;
    }
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    d.intervalH = h;
    drafts.set(telegramId, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_interval_done', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    const d = await loadDraft(telegramId);
    putDraft(telegramId, { ...clampSchedulePrefs(d), view: 'main' }, d);
    await renderPanel(ctx, telegramId, true);
    await ctx.answerCbQuery();
  });

  bot.action('horario_save', async (ctx) => {
    const telegramId = String(ctx.from!.id);
    if (!(await requireVip(telegramId))) {
      await ctx.answerCbQuery('Solo VIP.', { show_alert: true });
      return;
    }
    try {
      const d = await loadDraft(telegramId);
      const saved = await saveDigestPrefs(telegramId, d);

      // Acortar espera si redujeron el intervalo
      const { getNextRegularAtMs, setNextRegularAtMs } = await import('../services/warmup.service');
      const nextAt = await getNextRegularAtMs(telegramId);
      const now = Date.now();
      const intervalMs = saved.intervalH * 60 * 60 * 1000;
      if (nextAt !== null && nextAt > now && nextAt > now + intervalMs) {
        await setNextRegularAtMs(telegramId, now + intervalMs);
      }

      drafts.set(telegramId, clonePrefs(saved));
      const text = [
        `✅ <b>Horario guardado</b>`,
        ``,
        `📅 ${formatDigestDays(saved.days)}`,
        `🕐 ${formatHourRange(saved.startHour, saved.endHour)}`,
        `🔁 Cada ${saved.intervalH} h`,
        ``,
        `<i>Los resúmenes solo se envían dentro de esta ventana.</i>`,
      ].join('\n');

      await safeEdit(ctx, text, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Editar horario', 'vip_horario')],
        ]).reply_markup,
      });
      await ctx.answerCbQuery('Guardado');
    } catch (error) {
      logger.error('horario_save', { error: (error as Error).message });
      await ctx.answerCbQuery('Error al guardar', { show_alert: true });
    }
  });
}
