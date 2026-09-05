import { Context, Markup, Telegraf } from 'telegraf';
import { getFiltrosUsuario, radarIsConfigured, type RadarFiltros } from '../db/filters.queries';
import { getUsuarioPorTelegramId } from '../db/queries';
import { replaceFiltersAndResyncQueue } from '../services/matching.service';
import {
  buildPujaButtons,
  formatStockLine,
  getStockContext,
  listBrandsFromInventory,
  listCcaaFromInventory,
  listModelsFromInventory,
} from '../services/inventory.service';
import { logger } from '../services/logger';

// ============================================================
// Radar VIP — Marca · Modelo · Comunidad · Puja
// Cada filtro: selección + ✅ Aplicar + 🔄 Reset (recarga discreta)
// ============================================================

type Draft = {
  marcaNorm: string | null;
  marcaLabel: string;
  modeloNorm: string | null;
  modeloLabel: string;
  /** Selección pendiente en pantalla Marca (hasta Aplicar) */
  pendingMarcaNorm: string | null;
  pendingMarcaLabel: string;
  pendingModeloNorm: string | null;
  pendingModeloLabel: string;
  ccaaNorms: string[];
  ccaaLabels: string[];
  pujaOptions: Array<number | null>;
  puja_maxima: number | null;
  page: number;
};

const drafts = new Map<string, Draft>();
const PAGE_SIZE = 8;

/** Limpia draft en memoria (purga /borrar_datos). */
export function clearFilterDraft(telegramId: string): void {
  drafts.delete(telegramId);
}

function emptyDraft(): Draft {
  return {
    marcaNorm: null,
    marcaLabel: '',
    modeloNorm: null,
    modeloLabel: '',
    pendingMarcaNorm: null,
    pendingMarcaLabel: '',
    pendingModeloNorm: null,
    pendingModeloLabel: '',
    ccaaNorms: [],
    ccaaLabels: [],
    pujaOptions: [],
    puja_maxima: null,
    page: 0,
  };
}

async function loadDraft(telegramId: string): Promise<Draft> {
  if (drafts.has(telegramId)) return drafts.get(telegramId)!;
  const f = await getFiltrosUsuario(telegramId);
  const d: Draft = {
    ...emptyDraft(),
    marcaNorm: f.marcaNorm ?? null,
    marcaLabel: f.marcaNorm ?? '',
    modeloNorm: f.modeloNorm ?? null,
    modeloLabel: f.modeloNorm ?? '',
    pendingMarcaNorm: f.marcaNorm ?? null,
    pendingMarcaLabel: f.marcaNorm ?? '',
    pendingModeloNorm: f.modeloNorm ?? null,
    pendingModeloLabel: f.modeloNorm ?? '',
    ccaaNorms: f.ccaaNorms?.length ? [...f.ccaaNorms] : [],
    ccaaLabels: f.comunidades?.length ? [...f.comunidades] : [],
    puja_maxima: f.puja_maxima,
    pujaOptions: f.puja_maxima != null ? [f.puja_maxima] : [],
  };
  // Recuperar labels bonitos si podemos
  if (d.marcaNorm) {
    const brands = await listBrandsFromInventory();
    const hit = brands.find((b) => b.brandNorm === d.marcaNorm);
    if (hit) {
      d.marcaLabel = hit.label;
      d.pendingMarcaLabel = hit.label;
    }
  }
  if (d.marcaNorm && d.modeloNorm) {
    const models = await listModelsFromInventory(d.marcaNorm);
    const hit = models.find((m) => m.modelNorm === d.modeloNorm);
    if (hit) {
      d.modeloLabel = hit.label;
      d.pendingModeloLabel = hit.label;
    }
  }
  drafts.set(telegramId, d);
  return d;
}

function saveDraft(telegramId: string, d: Draft): void {
  drafts.set(telegramId, d);
}

/** Tras cambiar marca → modelo, CCAA y puja a pendiente (Cualquiera / —). */
function resetDownstreamOfBrand(d: Draft): void {
  d.modeloNorm = null;
  d.modeloLabel = '';
  d.pendingModeloNorm = null;
  d.pendingModeloLabel = '';
  d.ccaaNorms = [];
  d.ccaaLabels = [];
  d.pujaOptions = [];
  d.puja_maxima = null;
  d.page = 0;
}

/** Tras cambiar modelo → CCAA y puja a pendiente (Cualquiera). */
function resetDownstreamOfModel(d: Draft): void {
  d.ccaaNorms = [];
  d.ccaaLabels = [];
  d.pujaOptions = [];
  d.puja_maxima = null;
  d.page = 0;
}

function draftToFiltros(telegramId: string, d: Draft): RadarFiltros {
  return {
    telegram_id: telegramId,
    tipos: [],
    comunidades: d.ccaaLabels.length ? d.ccaaLabels : d.ccaaNorms,
    puja_maxima: d.puja_maxima,
    origenes: [],
    etiquetas: [],
    estados: [],
    marcaNorm: d.marcaNorm,
    modeloNorm: d.modeloNorm,
    versions: [],
    ccaaNorms: d.ccaaNorms,
  };
}

function chunkButtons<T>(items: T[], perRow: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
}

function footerResetAplicar(applyAction: string, resetAction: string) {
  return [
    [
      Markup.button.callback('🔄 Reset', resetAction),
      Markup.button.callback('✅ Aplicar', applyAction),
    ],
    [Markup.button.callback('🔙 Panel', 'radar_home')],
  ];
}

/** Solo edita el mensaje actual — nunca envía uno nuevo */
async function editDiscreto(
  ctx: Context,
  text: string,
  buttons: ReturnType<typeof Markup.button.callback>[][]
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  } catch {
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: buttons });
    } catch {
      /* silencio: evita duplicar mensajes */
    }
  }
}

export async function mostrarPanelFiltros(ctx: Context) {
  const telegramId = String(ctx.from?.id ?? '');
  const user = await getUsuarioPorTelegramId(telegramId);
  if (!user || (user.estado !== 'Pagado' && user.estado !== 'Cancelando')) {
    await ctx.reply('⚠️ Solo los usuarios VIP pueden configurar el radar.');
    return;
  }

  const d = await loadDraft(telegramId);
  const stock = await getStockContext({
    marcaNorm: d.marcaNorm,
    modeloNorm: d.modeloNorm,
    ccaaNorms: d.ccaaNorms,
  });

  const lines = [
    `⚙️ <b>Radar VIP — tus filtros</b>`,
    ``,
    `🚗 <b>Marca:</b> ${d.marcaLabel || d.marcaNorm || '—'}`,
    `📦 <b>Modelo:</b> ${d.modeloLabel || d.modeloNorm || '—'}`,
    `📍 <b>Comunidad Autónoma:</b> ${
      d.ccaaLabels.length
        ? d.ccaaLabels.join(', ')
        : d.ccaaNorms.length
          ? d.ccaaNorms.join(', ')
          : 'Cualquiera'
    }`,
    `💰 <b>Puja máx:</b> ${
      d.puja_maxima != null ? d.puja_maxima.toLocaleString('es-ES') + '€' : 'Cualquiera'
    }`,
    ``,
    `<i>${formatStockLine(stock)}</i>`,
  ];
  if (!radarIsConfigured(draftToFiltros(telegramId, d))) {
    lines.push('', `<i>Configura al menos marca, Comunidad Autónoma o puja y pulsa Listo.</i>`);
  }
  const texto = lines.join('\n');

  const botones = [
    [Markup.button.callback('🚗 Marca', 'radar_brand'), Markup.button.callback('📦 Modelo', 'radar_model')],
    [Markup.button.callback('📍 Comunidad Autónoma', 'radar_ccaa'), Markup.button.callback('💰 Puja máxima', 'radar_puja')],
    [Markup.button.callback('🔄 Reset', 'radar_reset'), Markup.button.callback('✅ Listo', 'radar_done')],
  ];

  if (ctx.callbackQuery) {
    await editDiscreto(ctx, texto, botones);
  } else {
    await ctx.reply(texto, { parse_mode: 'HTML', reply_markup: { inline_keyboard: botones } });
  }
}

export function registerFilterHandlers(bot: Telegraf) {
  bot.action('filter_main', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarPanelFiltros(ctx);
  });
  bot.action('radar_home', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarPanelFiltros(ctx);
  });

  // ---- Marca ----
  bot.action('radar_brand', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.page = 0;
    d.pendingMarcaNorm = d.marcaNorm;
    d.pendingMarcaLabel = d.marcaLabel;
    saveDraft(telegramId, d);
    await renderBrandPage(ctx, telegramId);
  });

  bot.action(/radar_brand_page_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.page = parseInt(ctx.match[1]!, 10);
    saveDraft(telegramId, d);
    await renderBrandPage(ctx, telegramId);
  });

  bot.action(/radar_set_brand_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const brandNorm = decodeURIComponent(ctx.match[1]!);
    const brands = await listBrandsFromInventory();
    const hit = brands.find((b) => b.brandNorm === brandNorm);
    const d = await loadDraft(telegramId);
    d.pendingMarcaNorm = brandNorm;
    d.pendingMarcaLabel = hit?.label ?? brandNorm;
    saveDraft(telegramId, d);
    await renderBrandPage(ctx, telegramId);
  });

  bot.action('radar_apply_brand', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    const changedBrand = d.marcaNorm !== d.pendingMarcaNorm;
    d.marcaNorm = d.pendingMarcaNorm;
    d.marcaLabel = d.pendingMarcaLabel;
    if (changedBrand) {
      // Cambio de marca → reset total de dependientes (modelo, CCAA, puja)
      resetDownstreamOfBrand(d);
    }
    saveDraft(telegramId, d);
    await ctx.answerCbQuery(
      changedBrand ? 'Marca aplicada ✅ Filtros siguientes reiniciados' : 'Marca aplicada ✅'
    );
    await mostrarPanelFiltros(ctx);
  });

  bot.action('radar_reset_brand', async (ctx) => {
    await ctx.answerCbQuery('Marca restablecida');
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.pendingMarcaNorm = null;
    d.pendingMarcaLabel = '';
    d.marcaNorm = null;
    d.marcaLabel = '';
    resetDownstreamOfBrand(d);
    saveDraft(telegramId, d);
    await renderBrandPage(ctx, telegramId);
  });

  // ---- Modelo ----
  bot.action('radar_model', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    if (!d.marcaNorm) {
      await ctx.answerCbQuery('Elige marca primero');
      d.page = 0;
      d.pendingMarcaNorm = d.marcaNorm;
      saveDraft(telegramId, d);
      await renderBrandPage(ctx, telegramId);
      return;
    }
    await ctx.answerCbQuery();
    d.page = 0;
    d.pendingModeloNorm = d.modeloNorm;
    d.pendingModeloLabel = d.modeloLabel;
    saveDraft(telegramId, d);
    await renderModelPage(ctx, telegramId);
  });

  bot.action(/radar_model_page_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.page = parseInt(ctx.match[1]!, 10);
    saveDraft(telegramId, d);
    await renderModelPage(ctx, telegramId);
  });

  bot.action(/radar_set_model_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const modelNorm = decodeURIComponent(ctx.match[1]!);
    const d = await loadDraft(telegramId);
    if (!d.marcaNorm) return;
    const models = await listModelsFromInventory(d.marcaNorm);
    const hit = models.find((m) => m.modelNorm === modelNorm);
    d.pendingModeloNorm = modelNorm;
    d.pendingModeloLabel = hit?.label ?? modelNorm;
    saveDraft(telegramId, d);
    await renderModelPage(ctx, telegramId);
  });

  bot.action('radar_model_any', async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.pendingModeloNorm = null;
    d.pendingModeloLabel = 'Cualquiera';
    saveDraft(telegramId, d);
    await renderModelPage(ctx, telegramId);
  });

  bot.action('radar_apply_model', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    const nextNorm = d.pendingModeloNorm;
    const nextLabel =
      d.pendingModeloLabel || (d.pendingModeloNorm ? d.pendingModeloNorm : 'Cualquiera');
    const changedModel =
      d.modeloNorm !== nextNorm ||
      (d.modeloLabel || '') !== (nextLabel === 'Cualquiera' && !nextNorm ? '' : nextLabel);
    d.modeloNorm = nextNorm;
    d.modeloLabel = nextNorm ? nextLabel : '';
    if (changedModel) {
      // Cambio de modelo → reset CCAA + puja
      resetDownstreamOfModel(d);
    }
    saveDraft(telegramId, d);
    await ctx.answerCbQuery(
      changedModel ? 'Modelo aplicado ✅ CCAA y puja reiniciados' : 'Modelo aplicado ✅'
    );
    await mostrarPanelFiltros(ctx);
  });

  bot.action('radar_reset_model', async (ctx) => {
    await ctx.answerCbQuery('Modelo restablecido');
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.pendingModeloNorm = null;
    d.pendingModeloLabel = '';
    d.modeloNorm = null;
    d.modeloLabel = '';
    resetDownstreamOfModel(d);
    saveDraft(telegramId, d);
    await renderModelPage(ctx, telegramId);
  });

  // ---- Comunidad ----
  bot.action('radar_ccaa', async (ctx) => {
    await ctx.answerCbQuery();
    await renderCcaaPage(ctx, String(ctx.from?.id ?? ''));
  });

  bot.action(/radar_tog_ccaa_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const ccaaNorm = decodeURIComponent(ctx.match[1]!);
    const d = await loadDraft(telegramId);
    const list = await listCcaaFromInventory({
      marcaNorm: d.marcaNorm,
      modeloNorm: d.modeloNorm,
    });
    const hit = list.find((c) => c.ccaaNorm === ccaaNorm);
    if (d.ccaaNorms.includes(ccaaNorm)) {
      d.ccaaNorms = d.ccaaNorms.filter((c) => c !== ccaaNorm);
      d.ccaaLabels = d.ccaaLabels.filter((l) => l !== (hit?.label ?? ccaaNorm));
    } else {
      d.ccaaNorms.push(ccaaNorm);
      d.ccaaLabels.push(hit?.label ?? ccaaNorm);
    }
    saveDraft(telegramId, d);
    await renderCcaaPage(ctx, telegramId);
  });

  bot.action('radar_ccaa_all', async (ctx) => {
    await ctx.answerCbQuery('Cualquiera');
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.ccaaNorms = [];
    d.ccaaLabels = [];
    saveDraft(telegramId, d);
    await renderCcaaPage(ctx, telegramId);
  });

  bot.action('radar_apply_ccaa', async (ctx) => {
    await ctx.answerCbQuery('Comunidad Autónoma aplicada ✅');
    await mostrarPanelFiltros(ctx);
  });

  bot.action('radar_reset_ccaa', async (ctx) => {
    await ctx.answerCbQuery('Comunidad Autónoma restablecida');
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.ccaaNorms = [];
    d.ccaaLabels = [];
    saveDraft(telegramId, d);
    await renderCcaaPage(ctx, telegramId);
  });

  // ---- Puja ----
  bot.action('radar_puja', async (ctx) => {
    await ctx.answerCbQuery();
    await renderPujaPage(ctx, String(ctx.from?.id ?? ''));
  });

  bot.action(/radar_tog_puja_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from?.id ?? '');
    const raw = ctx.match[1]!;
    const value: number | null = raw === 'null' ? null : parseInt(raw, 10);
    const d = await loadDraft(telegramId);
    const key = value === null ? 'null' : String(value);
    const has = d.pujaOptions.some((p) => (p === null ? 'null' : String(p)) === key);
    if (has) {
      d.pujaOptions = d.pujaOptions.filter((p) => (p === null ? 'null' : String(p)) !== key);
    } else if (value === null) {
      d.pujaOptions = [null];
    } else {
      d.pujaOptions = d.pujaOptions.filter((p) => p !== null).concat(value);
    }
    saveDraft(telegramId, d);
    await renderPujaPage(ctx, telegramId);
  });

  bot.action('radar_apply_puja', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    if (!d.pujaOptions.length || d.pujaOptions.includes(null)) d.puja_maxima = null;
    else d.puja_maxima = Math.max(...(d.pujaOptions as number[]));
    saveDraft(telegramId, d);
    await ctx.answerCbQuery('Puja aplicada ✅');
    await mostrarPanelFiltros(ctx);
  });

  bot.action('radar_reset_puja', async (ctx) => {
    await ctx.answerCbQuery('Puja restablecida');
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);
    d.pujaOptions = [];
    d.puja_maxima = null;
    saveDraft(telegramId, d);
    await renderPujaPage(ctx, telegramId);
  });

  // ---- Panel Reset / Listo ----
  bot.action('radar_reset', async (ctx) => {
    await ctx.answerCbQuery('Radar reiniciado');
    const telegramId = String(ctx.from?.id ?? '');
    drafts.set(telegramId, emptyDraft());
    await replaceFiltersAndResyncQueue(telegramId, draftToFiltros(telegramId, emptyDraft()));
    const { cancelDigestWarmup } = await import('../services/warmup.service');
    await cancelDigestWarmup(telegramId);
    await mostrarPanelFiltros(ctx);
  });

  bot.action('radar_done', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    const d = await loadDraft(telegramId);

    // Defensa: si el modelo no pertenece a la marca actual, limpiarlo
    if (d.marcaNorm && d.modeloNorm) {
      const models = await listModelsFromInventory(d.marcaNorm);
      const ok = models.some((m) => m.modelNorm === d.modeloNorm);
      if (!ok) {
        d.modeloNorm = null;
        d.modeloLabel = '';
        d.pendingModeloNorm = null;
        d.pendingModeloLabel = '';
        saveDraft(telegramId, d);
      }
    }

    const filtros = draftToFiltros(telegramId, d);
    if (!radarIsConfigured(filtros)) {
      await ctx.answerCbQuery('Configura marca, Comunidad Autónoma o puja antes de guardar');
      return;
    }
    try {
      const { changed } = await replaceFiltersAndResyncQueue(telegramId, filtros);

      const {
        resetDigestCadenceOnFilterApply,
        scheduleDigestWarmup,
      } = await import('../services/warmup.service');

      // Cadencia regular siempre se reinicia al Aplicar (ilimitado). Warmup sí tiene cuota 24 h.
      await resetDigestCadenceOnFilterApply(telegramId);
      await scheduleDigestWarmup(telegramId);

      await ctx.answerCbQuery(changed ? 'Radar guardado ✅' : 'Radar aplicado ✅');

      await editDiscreto(
        ctx,
        ['✅ <b>Radar actualizado</b>', '', 'Tu radar VIP está activo 24/7.'].join('\n'),
        [[Markup.button.callback('⚙️ Volver al panel', 'radar_home')]]
      );
    } catch (error) {
      logger.error('radar_done', { error: (error as Error).message });
      await ctx.answerCbQuery('Error al guardar');
    }
  });

  bot.action('filter_listo', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarPanelFiltros(ctx);
  });
  bot.action('filter_reset', async (ctx) => {
    await ctx.answerCbQuery();
    await mostrarPanelFiltros(ctx);
  });
}

async function renderBrandPage(ctx: Context, telegramId: string) {
  const d = await loadDraft(telegramId);
  const brands = await listBrandsFromInventory();
  const stock = await getStockContext({});
  const page = d.page;
  const slice = brands.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const buttons = chunkButtons(
    slice.map((b) =>
      Markup.button.callback(
        `${d.pendingMarcaNorm === b.brandNorm ? '✅ ' : ''}${b.label} (${b.count})`,
        `radar_set_brand_${encodeURIComponent(b.brandNorm)}`
      )
    ),
    2
  );

  const nav: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0) nav.push(Markup.button.callback('⬅️', `radar_brand_page_${page - 1}`));
  if ((page + 1) * PAGE_SIZE < brands.length) nav.push(Markup.button.callback('➡️', `radar_brand_page_${page + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push(...footerResetAplicar('radar_apply_brand', 'radar_reset_brand'));

  const sel = d.pendingMarcaLabel || d.pendingMarcaNorm || 'ninguna';
  const text = [
    `🚗 <b>Elige marca</b>`,
    `<i>${formatStockLine(stock)}</i>`,
    `Solo marcas del catálogo con stock. Orden A–Z.`,
    `Marca y pulsa <b>✅ Aplicar</b> (no salta a modelo).`,
    ``,
    `Selección: <b>${sel}</b>`,
  ].join('\n');

  await editDiscreto(ctx, text, buttons);
}

async function renderModelPage(ctx: Context, telegramId: string) {
  const d = await loadDraft(telegramId);
  if (!d.marcaNorm) {
    await renderBrandPage(ctx, telegramId);
    return;
  }
  const models = await listModelsFromInventory(d.marcaNorm);
  const stock = await getStockContext({ marcaNorm: d.marcaNorm });
  const page = d.page;
  const slice = models.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const buttons = chunkButtons(
    slice.map((m) =>
      Markup.button.callback(
        `${d.pendingModeloNorm === m.modelNorm ? '✅ ' : ''}${m.label} (${m.count})`,
        `radar_set_model_${encodeURIComponent(m.modelNorm)}`
      )
    ),
    2
  );

  const nav: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0) nav.push(Markup.button.callback('⬅️', `radar_model_page_${page - 1}`));
  if ((page + 1) * PAGE_SIZE < models.length) nav.push(Markup.button.callback('➡️', `radar_model_page_${page + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([
    Markup.button.callback(
      `${d.pendingModeloNorm == null && d.pendingModeloLabel === 'Cualquiera' ? '✅ ' : ''}🌐 Cualquier modelo`,
      'radar_model_any'
    ),
  ]);
  buttons.push(...footerResetAplicar('radar_apply_model', 'radar_reset_model'));

  const isSpecial =
    d.marcaNorm === 'bicicletas' || d.marcaNorm === 'remolque';
  const sel = d.pendingModeloLabel || d.pendingModeloNorm || 'ninguno';
  const text = [
    `📦 <b>Modelo · ${d.marcaLabel || d.marcaNorm}</b>`,
    `<i>${formatStockLine(stock)}</i>`,
    isSpecial
      ? `Categorías compactas. Marca y <b>✅ Aplicar</b>.`
      : `Elige modelo y pulsa <b>✅ Aplicar</b>.`,
    ``,
    `Selección: <b>${sel}</b>`,
  ].join('\n');

  await editDiscreto(ctx, text, buttons);
}

async function renderCcaaPage(ctx: Context, telegramId: string) {
  const d = await loadDraft(telegramId);
  const list = await listCcaaFromInventory({
    marcaNorm: d.marcaNorm,
    modeloNorm: d.modeloNorm,
  });
  const stock = await getStockContext({
    marcaNorm: d.marcaNorm,
    modeloNorm: d.modeloNorm,
    ccaaNorms: d.ccaaNorms,
  });

  // 1 por fila: en móvil Telegram trunca nombres largos (Castilla-La Mancha…) en 2 columnas
  const buttons = chunkButtons(
    list.map((c) =>
      Markup.button.callback(
        `${d.ccaaNorms.includes(c.ccaaNorm) ? '✅ ' : ''}${c.label} (${c.count})`,
        `radar_tog_ccaa_${encodeURIComponent(c.ccaaNorm)}`
      )
    ),
    1
  );
  buttons.unshift([
    Markup.button.callback(
      `${d.ccaaNorms.length === 0 ? '✅ ' : ''}🇪🇸 Cualquiera`,
      'radar_ccaa_all'
    ),
  ]);
  buttons.push(...footerResetAplicar('radar_apply_ccaa', 'radar_reset_ccaa'));

  const seleccion =
    d.ccaaNorms.length === 0
      ? 'Cualquiera'
      : d.ccaaLabels.length
        ? d.ccaaLabels.join(', ')
        : d.ccaaNorms.join(', ');

  const text = [
    `📍 <b>Comunidad Autónoma</b> <i>(multi-selección)</i>`,
    `<i>${formatStockLine(stock)}</i>`,
    `Elige una o varias comunidades autónomas de España y pulsa <b>✅ Aplicar</b>.`,
    ``,
    `Selección: <b>${seleccion}</b>`,
  ].join('\n');

  await editDiscreto(ctx, text, buttons);
}

async function renderPujaPage(ctx: Context, telegramId: string) {
  const d = await loadDraft(telegramId);
  const stock = await getStockContext({
    marcaNorm: d.marcaNorm,
    modeloNorm: d.modeloNorm,
    ccaaNorms: d.ccaaNorms,
  });
  const opts = buildPujaButtons(stock);

  const isSelected = (value: number | null) =>
    d.pujaOptions.some((p) => (p === null && value === null) || (p !== null && value !== null && p === value));

  const buttons = opts.map((o) => [
    Markup.button.callback(
      `${isSelected(o.value) ? '✅ ' : ''}${o.label}`,
      `radar_tog_puja_${o.value === null ? 'null' : o.value}`
    ),
  ]);
  buttons.push(...footerResetAplicar('radar_apply_puja', 'radar_reset_puja'));

  const preview =
    !d.pujaOptions.length || d.pujaOptions.includes(null)
      ? 'Cualquiera'
      : `Hasta ${Math.max(...(d.pujaOptions as number[])).toLocaleString('es-ES')}€`;

  const text = [
    `💰 <b>Puja máxima inicial</b> <i>(multi-selección)</i>`,
    `<i>${formatStockLine(stock)}</i>`,
    `Marca topes y pulsa <b>✅ Aplicar</b> (se usa el más alto).`,
    ``,
    `Selección: <b>${preview}</b>`,
  ].join('\n');

  await editDiscreto(ctx, text, buttons);
}
