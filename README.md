# Alertas VIP Subastas — Architecture & Operations Handbook

> **Purpose:** SSOT de producto, arquitectura, crons, Redis, scrapers, filtros, matching, IA, Stripe, seguridad y **decisiones de diseño (por qué)**.  
> Actualizar este archivo cuando cambies arquitectura, cupos, cadencias u ops.  
> Índice rápido: §2.1 APP_ROLE · §6 Crons · §8 Digests/warmup · §8.6 `/horario` · §9 Radar · §10 IA · §11 Stripe · §13 Comandos · §16 Decisiones · §24 Checklist.

---

## 0. Pitch (portfolio)

**Alertas VIP Subastas** es un Micro-SaaS de Telegram que avisa en tiempo casi real de **subastas de vehículos embargados** en España (BOE, Escrapalia, eActivos, Procuradores).

- **Problema:** el inventario es escaso y se mueve rápido; mirar portales a mano no escala.
- **Solución:** radar personal (marca / modelo / CCAA / puja) + digests VIP en Telegram + canal freemium FOMO + asesor IA acotado.
- **Stack:** Node/TypeScript, Telegraf, Prisma/PostgreSQL, Redis, Stripe Live, Docker Compose (app + scraper separados), backups R2.
- **Ops:** contenedores non-root, secretos redactados, webhooks firmados, `verify:system`, CI ligero, recordatorio mensual de deps/restore.

Ideal como pieza de portfolio: producto real en producción, pagos Live, scrapers multi-portal y seguridad operativa medible.

---

## 1. What this product is

**Alertas VIP Subastas** is a Telegram Micro-SaaS that:

1. Scrapes Spanish **vehicle auction** portals (BOE, Escrapalia, eActivos, Procuradores) into Postgres.
2. Lets VIP users configure a **radar** (brand / model / CCAA / max starting bid).
3. Matches new inventory to VIP alerts and delivers **batched digests** via Redis (not spam). Each VIP sets **days / hours / interval** with `/horario` (defaults: every **2 h**, **08:00–21:00** Madrid; hard floor **07–23**).
4. Offers an **AI auction advisor** (GPT-4o-mini) with filter + recent chat context.
5. Monetizes via **Stripe Payment Links** (tiered by VIP count).
6. Publishes a **public freemium channel** (FOMO: **1×/día 10:00 Madrid**, lotes que cierran en **3–24 h**, **sin enlace**).

**Deploy model:** dual Node containers — `alertas-bot` (`APP_ROLE=app`: Telegram + Stripe + matching + digests + backup) and `alertas-scraper` (`APP_ROLE=scraper`: inventory only, no TG/Stripe/OpenAI/R2). Postgres + Redis on the internal network. Both use **`TZ=Europe/Madrid`**.

**Schedule split:**

| Lane | When |
|------|------|
| **Scrapers** (new inventory) | **Mon–Fri** (default `SCRAPER_CRON` 08/14/20) |
| **Digests / radar delivery** | **Per VIP** via `/horario` (días + horas + intervalo 1–4 h). Defaults: **L–D**, **08:00–21:00**, cada **2 h**. Hard floor **07–23** |
| Matching | Still runs on inventory updates; the user’s window only delays **Telegram sends** |

Weekend digests reuse stock already in Postgres (no fresh portal ingest Sat–Sun).

**Scale honesty:** auctions of this type are scarce. Expect hundreds → ~1 000 live lots, not millions. We still design for **1 000+ VIP** and clean ops — prevent &gt; cure — without overbuilding for 5M cars.

---

## 2. Tech stack & tools

| Layer | Tool | Why |
|-------|------|-----|
| Runtime | **Node** + **TypeScript** | Existing codebase; Docker CMD builds with `tsc` |
| Bot | **Telegraf** | Telegram bot + inline keyboards |
| HTTP API | **Express** | Stripe webhooks + `/health` (`PORT`; compose **3002**) |
| ORM / DB | **Prisma 6** + **PostgreSQL 16** | Typed schema; source of truth |
| Cache / queues | **Redis 7** + **ioredis** | Inventory cache, alert index, notification digests; **memory fallback** if Redis down |
| Scraping | **Cheerio**, **Axios**, **Playwright-core** | HTTP/API donde basta; Playwright solo BOE |
| Anti-bot | *(retirado)* | Bright Data eliminado del código; scrapers directos |
| AI | **OpenAI** (`gpt-4o-mini`) | Asesor embargos + recuperación de anuncios (cupos duros) |
| Payments | **Stripe** (Payment Links + webhooks) | VIP upgrade / cancel / reactivate |
| Backups | **Cloudflare R2** (S3 API) *target* | Offsite `pg_dump`; Telegram admin = **CRITICAL only** (no dump files) |
| Scheduling | **node-cron** | Scrapers, notifier flush, cleanup, stats, backup |
| Container | **Docker Compose** | `alertas-bot` + `alertas-scraper` + `postgres` + `redis` |

**npm scripts:**

```bash
npm run dev                # local bot + jobs (APP_ROLE=all)
npm run build              # prisma generate + tsc + copy car-specifications.json
npm start                  # node dist/index.js
npm run scraper            # un ciclo scrapers
npm run notifier           # canal público FOMO manual (= cron 10:00)
npm run flush-queue        # tick digest VIP manual
npm run cleanup            # verificación enlaces + limpieza física
npm run stats              # refresh InventoryStats manual
npm run title-cleanup      # limpieza marca/modelo desde título
npm run backup             # backup R2 manual
npm run restore:latest     # restore R2 (CONFIRM_RESTORE=YES)
npm run verify:system      # smoke post-deploy (env + DB + Redis + /health)
npm run verify:system:dev  # idem con ts-node
npm run ops:reminder       # recordatorio ops mensual (manual)
npm run migrate:boot       # migrate deploy + baseline legacy
npm run db:migrate         # prisma migrate deploy
npm run typecheck          # tsc --noEmit
npm run ci                 # typecheck + npm audit (high+)
# Admin / mantenimiento:
npm run backfill-norms     # rellena norms en vehículos antiguos
npm run check-matches      # diagnóstico matching
npm run reset-counts       # marca lotes como no publicados (dev/ops)
# SOLO DEV (destructivo):
# npm run db:push / db:reset
```

Plantilla de variables: **`.env.example`** → copiar a `.env` (`chmod 600` en VPS).

---

## 2.1 APP_ROLE — por qué dos contenedores

| | `APP_ROLE=app` (`alertas-bot`) | `APP_ROLE=scraper` (`alertas-scraper`) | `all` (local) |
|--|--|--|--|
| Telegram + Stripe webhook | ✅ | ❌ | ✅ |
| Matching + digests + FOMO | ✅ | ❌ | ✅ |
| Scrapers + title-cleanup | ❌ | ✅ | ✅ |
| Secrets TG/Stripe/OpenAI/R2 | `env_file: .env` | **no** (solo DB/Redis + knobs scraper) | `.env` |
| HTTP `/health` | ✅ | ❌ | ✅ |
| Compose depends_on | postgres + redis healthy | + **bot healthy** (espera migraciones) | — |

**Por qué:** scrapers (Playwright) son CPU/RAM heavy y no deben compartir proceso con el bot; el scraper no recibe secretos de pago/IA; el bot arranca primero (`migrate-boot`) para que la schema exista antes del scrape.

**Boot timeouts (app):** VIP counter ~12 s · matching inicial ~8 s (si no hay scraper in-process) · primer flush tick ~5 min.  
**Boot (scraper):** scrape inicial ~3 s · InventoryStats solo **post-scrape** (no hay cron de stats en app).

---

## 3. Repository layout

```
Alertas_VIP_subastas/
├── src/
│   ├── index.ts                 # Bootstrap: bot, Express, crons por APP_ROLE
│   ├── db/
│   │   ├── prisma.ts, redis.ts, queries.ts, filters.queries.ts
│   ├── jobs/
│   │   ├── scraper.job.ts       # Multi-portal + page-window state
│   │   ├── notifier.job.ts      # Matching VIP + canal público 10:00
│   │   ├── queue-flush.job.ts   # Digests VIP (warmup + regular)
│   │   ├── cleanup.job.ts, backup.job.ts, restore.job.ts
│   │   ├── inventory-stats.job.ts, title-cleanup.job.ts
│   │   └── ops-reminder.job.ts
│   ├── scrapers/                # BOE, Escrapalia, eActivos, Procuradores + base
│   ├── services/
│   │   ├── matching, queue, cache, inventory, ai, sanitizer
│   │   ├── warmup.service.ts    # Cadencia/usuario + warmup cuota 24 h
│   │   ├── digest-schedule.service.ts  # Prefs /horario (días·horas·intervalo)
│   │   ├── telegram, alert, r2, vip-counter, logger, redacted-console
│   ├── bot/telegram.bot.ts, filters.menu.ts, horario.menu.ts
│   ├── webhooks/stripe.webhook.ts
│   ├── middlewares/             # Telegram + HTTP rate limits
│   ├── admin/                   # backfill_norms, check_matches, reset_counts
│   ├── scripts/                 # migrate-boot, verify-system
│   ├── data/car-specifications.json
│   └── utils/                   # normalizer, brand-catalog, scraper-state, app-role
├── prisma/schema.prisma + migrations/
├── .env.example
├── docker-compose.yml, Dockerfile
└── README.md
```

---

## 4. Data model (Prisma)

| Model | Role |
|-------|------|
| **Vehiculo** | PK `(id_subasta, id_lote, portal)` + `marca`/`modelo` + **`marcaNorm`/`modeloNorm`/`versionTokens`/`ccaaNorm`** + puja + fechas + flags públicos + **`revisado`** (title cleanup) |
| **UsuarioVIP** | `telegram_id`, estado, Stripe ids, cupos IA, **digest prefs** (`digest_days[]`, `digest_start_hour`, `digest_end_hour`, `digest_interval_h`), `vip_ended_at` / `datos_purgados_at` |
| **UsuarioFiltros** | Radar VIP: `marcaNorm`, `modeloNorm`, `versions[]`, `ccaaNorms[]`, `puja_maxima`, `fingerprint` |
| **InventoryStats** | Agregados para UX filtros (marca/modelo/versión/CCAA + puja min/max/avg) |
| **NotificacionVIPEnviada** | Dedup digests: unique `(telegram_id, id_subasta, id_lote, portal)` |
| **ScraperLog** | Métricas por ejecución |
| **ScraperState** | Ventanas de paginación por portal |
| **AppMeta** | KV ops (p. ej. message_id contador VIP admin) |

**Design decisions:**

- **Norms** enable indexed matching instead of fragile string equality / ILIKE on the hot path.
- **`versionTokens`** (+ GIN when needed) for multi-spec OR matching from messy auction titles.
- **CCAA canon** = sanitizer output (`Comunidad de Madrid`, …). UI never offers a label that does not exist in DB.
- Postgres is **source of truth**. Redis is acceleration + queue only.

---

## 5. Runtime architecture (mental model)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Scrapers   │────▶│  Postgres    │◀───▶│ InventoryStats  │
│ page windows│     │  Vehiculo    │     │  (cron / post)  │
└─────────────┘     └──────┬───────┘     └────────┬────────┘
                           │                      │
                           ▼                      ▼
                    ┌──────────────┐      ┌───────────────┐
                    │   Matching   │      │ Filters menu  │
                    │  (slices)    │      │ (Redis cache) │
                    └──────┬───────┘      └───────────────┘
                           │
                           ▼
                    ┌──────────────┐      ┌───────────────┐
                    │ Redis lists  │─────▶│ Telegram VIP  │
                    │ notif:q:*    │tick  │ digests ≤3    │
                    └──────────────┘ ~2h  └───────────────┘

Public channel: FOMO **1×/día a las 10:00 Madrid** (sin enlace; independiente de la cola VIP)
Daily backup → R2 (target); Admin Telegram: CRITICAL only
```

---

## 6. Cron & batch schedule (`TZ=Europe/Madrid`)

| Time / expr | Job | Notes |
|-------------|-----|--------|
| `SCRAPER_CRON` (default `0 8,14,20 * * 1-5`) | **Scrapers** | Mon–Fri; page windows per portal (see §7) · rol `scraper` |
| Post-scrape only | **InventoryStats refresh** | Tras cada ciclo scraper (no cron aparte en app) |
| `*/5 7-22 * * *` (hard floor) | **Digest flush tick** | Cadencia **por VIP** vía `/horario` (`digest_interval_h` 1–4, default **2**). Defaults nuevos: 08–21. Hard floor `NOTIF_HARD_*` (7–23) · rol `app` |
| `* * * * *` | **Warmup digests** | Cola Redis tras Listo (5–15 min, cuota 24 h); respeta ventana `/horario` · rol `app` |
| `15,45 7-23 * * 1-5` | **Matching VIP** | Encola digests (`MATCHING_INTERVAL_MINUTES` ~30) · rol `app` |
| `0 10 * * *` Europe/Madrid | **Canal público FOMO** | **Fijo 10:00** todos los días · elegibles cierran en **3–24 h** · 1×/día · rol `app` |
| `0 6 * * *` (default) | **Backup R2** | `BACKUP_CRON` · rol `app` |
| `0 9 1 * *` (default) | **Ops reminder** | Deps + drill restore · rol `app` |
| `15 */2 * * *` | **Title cleanup** | Solo `revisado=false` · rol `scraper` |
| `0 2 * * 1-5` | Link / expiry verification | rol `app` |
| `0 4 * * 1-5` | Physical cleanup + purga VIP | Expired lots; `DATA_PURGE_HOURS` · rol `app` |

**Urgency (product):** lotes con `fecha_fin` &lt;6h se encolan como digest `urgent` (cabecera distinta); salen en el próximo flush due del usuario (warmup o regular) **dentro de su `/horario`**.

**Weekend:** scrapers off (Sat+Sun). Digests still deliver per each VIP’s `/horario` from existing stock.

---

## 7. Scraping strategy

### 7.1 Portals

| Portal | Approach | Notas |
|--------|----------|-------|
| **BOE** | Playwright-core list + HTTP detail | Browser headless en contenedor scraper |
| **Escrapalia** | Public JSON API | Sin browser |
| **eActivos** | Axios + Cheerio (endpoint AJAX `/listado-de-liquidaciones/obtener`) | Sin Bright Data |
| **Procuradores** | Axios + Cheerio | Prefer direct |

### 7.2 Page-window rotation (all paginated portals)

Auctions appear slowly and stay listed for a long time. Full re-scan every cycle wastes CPU/proxy budget.

| Phase | Window | When |
|-------|--------|------|
| Discovery | pages **1–N** bands | Solo si `SCRAPER_STEADY_ONLY=false` |
| **Steady (default)** | pages **1–5** | Inventario ya cargado — lo nuevo aparece al inicio |

State: **ScraperState** per portal.

Env: `SCRAPER_CRON` (default `0 8,14,20 * * 1-5` = L–V a las 8 / 14 / 20), `SCRAPER_STEADY_ONLY=true`, `SCRAPER_STEADY_PAGES=5`, `SCRAPER_WINDOW_SIZE=5`.

Todos los portales (BOE, Escrapalia, Procuradores, eActivos) van en el **mismo ciclo**; eActivos usa API HTTP (**sin Bright Data**).

### 7.3 Shared pipeline after scrape

1. Validate (`esVehiculoValido` — block parts/real estate/boats; drop &lt;3h life).
2. **Sanitize** RGPD + geo → **canonical CCAA**.
3. Fill **norms** (`marcaNorm`, `modeloNorm`, `versionTokens`, `ccaaNorm`).
4. Upsert + cross-portal near-dup skip when possible.
5. Refresh InventoryStats (**post-scrape**, mismo contenedor scraper).
6. Matching corre en el contenedor **app** (cron / post-boot), no dentro del scraper en prod.

### 7.4 How to change scraping

| Goal | Where |
|------|--------|
| Hours / days | `src/index.ts` cron + `SCRAPER_CRON` |
| Window sizes | env + `scraper-state.ts` |
| Menos carga | Prefer HTTP/API; steady 5 pages; Playwright solo BOE |

---

## 8. Redis strategy

**Principle:** Redis is **acceleration + queue**, not source of truth. If Redis dies, app continues with **in-memory fallback** (single-process).

### 8.1 Key namespaces

| Key pattern | Purpose | Typical TTL |
|-------------|---------|-------------|
| `inv:brands` | Brand list for filters | ~15 min |
| `inv:models:{brandNorm}` | Models | ~10 min |
| `inv:versions:{brand}:{model}` | Spec tokens | ~10 min |
| `inv:ccaa` | CCAA present in active stock | ~10 min |
| `inv:ctx:{…}` | Puja min/max/avg + count for UX line | ~5 min |
| `inv:gen` | Watermark to bust caches after stats refresh | — |
| `alerts:idx:{brand}:{model}` | VIP alerts for slice | ~3 min |
| `alerts:idx:any` | Catch-all alerts | ~3 min |
| `notif:q:{telegramId}` | **LIST** pending digest payloads | until flush |
| `digest:warmup:{telegramId}` | Primer lote rápido tras Aplicar (`dueAt` ms) | 5–15 min + margen |
| `digest:warmup_quota:{telegramId}` | Cuota anti-abuso warmup | `DIGEST_WARMUP_QUOTA_HOURS` (24 h) |
| `digest:next_regular:{telegramId}` | Próximo digest **regular** due (epoch ms) | intervalo + 7 d margen |
| `digest:cooldown:{telegramId}` | Debounce anti doble-fire tras un envío | ~90 s |
| `digest:prefs:{telegramId}` | Cache JSON prefs `/horario` | ~5 min |

### 8.2 Notification queue

- Matching **`RPUSH`** digest payloads; **`LTRIM`** keeps last `NOTIF_MAX_PENDING_PER_USER` (default **3**).
- Flush tick cada `NOTIFIER_TICK_MINUTES` (default **5**) dentro del **hard floor** (`NOTIF_HARD_*`): solo VIP con `now >= next_regular` **y** dentro de su ventana `/horario` → **`LPOP`** hasta `NOTIF_MAX_MESSAGES_PER_USER` (default **1**).
- Each message packs **≤ 3** auction lots.
- Cadencia regular **por usuario** = `UsuarioVIP.digest_interval_h` (1–4 h, default **2** vía `/horario`). `NOTIFIER_INTERVAL_MINUTES` (=120) seed/fallback para VIP nuevos.

### 8.3 Filter change → Redis policy

On VIP **Listo** / Aplicar:

1. Fingerprint old vs new filters; always overwrite alert row in Postgres.
2. **`resetDigestCadenceOnFilterApply`**: `next_regular = now + INTERVAL` + clear debounce (**siempre**).
3. **`scheduleDigestWarmup`**: pending / quota → no encolar; OK → cola 5–15 min + cuota 24 h.
4. If **changed**:
   - **`DEL notif:q:{telegramId}`**
   - Invalidate `alerts:idx:*`
   - **Seed** ≤1 digest from current stock under new rules (or no-stock notice)
5. If **unchanged**: leave pending queue alone (cadencia/warmup sí se procesan).

### 8.4 Compose Redis limits (soft launch)

- `maxmemory` **256mb**, `allkeys-lru`, AOF on.
- Container RAM limit (~320M) por encima de maxmemory.

### 8.5 Patrón — Warmup (cuota) + cadencia regular anclada al “Aplicar”

> Mismo patrón que Alertas VIP Inmobiliarias: (A) envío rápido tras guardar filtros, (B) ritmo estable que **no** se acelera abusando de Aplicar.

#### Dos canales (no mezclar)

| Canal | Qué es | Cuándo | Límite |
|-------|--------|--------|--------|
| **Warmup** | Primer lote tras Aplicar | 5–15 min después | **1× / 24 h** (`DIGEST_WARMUP_QUOTA_HOURS`) |
| **Regular** | Radar continuo (flush cola Redis) | cada N min desde el último Aplicar (o desde el último regular enviado) | Sin cuota diaria; reloj **por usuario** |

#### Qué NO se limita
- Aplicar / guardar filtros (BD) → **ilimitado**.
- El ciclo regular se **reinicia** en cada Aplicar (no se bloquea).
- El warmup **no** mueve `next_regular`.

#### Timeline ejemplo
```
T0     Usuario Aplicar filtros
T0     → next_regular = T0 + 2h
T0     → si cuota warmup OK → cola warmup (T0+5..15)
T0+10  Warmup envía (no toca next_regular)
T0+2h  Digest regular → next_regular = ahora + 2h
T0+3h  Usuario vuelve a Aplicar (sin warmup si cuota 24h activa)
T0+3h  → next_regular = T0+3h + 2h   ← reloj reiniciado
T0+5h  Digest regular con los filtros nuevos
```

#### Al Aplicar (`radar_done`)
```
1. Guardar preferencias en BD (+ resync cola si fingerprint cambia)
2. resetCadence(user): next_regular = now + INTERVAL   // siempre
3. clear debounce
4. scheduleWarmup(user):
     - pending / quota → no encolar
     - else SET warmup dueAt + SET quota 24h
5. UX: cadencia reiniciada + scheduled | pending | quota
```

#### Workers
```
Warmup (cada 1 min; respeta /horario del VIP):
  due = warmups con dueAt <= now
  si fuera de ventana → reprograma dueAt
  flush modo=warmup  → NO actualiza next_regular
  DEL cola warmup    → cuota permanece

Regular (tick cada 5 min; hard floor NOTIF_HARD_*):
  for each VIP con cola:
    if fuera de /horario → skip
    if debounce → skip
    if now < next_regular → skip   // (sin clave → due)
    flush modo=regular
    si enviado → next_regular = now + intervalH + debounce ~90s
```

#### Env
```
NOTIFIER_INTERVAL_MINUTES=120   # seed/fallback (VIP nuevos sin prefs)
NOTIFIER_TICK_MINUTES=5         # frecuencia del cron “quién está due”
NOTIF_HARD_START_HOUR=7         # hard floor sistema (inclusiva)
NOTIF_HARD_END_HOUR=23          # hard floor (exclusiva)
NOTIF_WINDOW_START_HOUR=8       # default /horario nuevos VIP
NOTIF_WINDOW_END_HOUR=21
MATCHING_INTERVAL_MINUTES=30    # matching VIP (independiente del canal público)
DIGEST_WARMUP_MIN_MINUTES=5
DIGEST_WARMUP_MAX_MINUTES=15
DIGEST_WARMUP_QUOTA_HOURS=24
```

#### Archivos
- `src/services/warmup.service.ts` — warmup, cuota, cadencia, cooldown
- `src/services/digest-schedule.service.ts` — prefs `/horario` + ventana Madrid
- `src/bot/horario.menu.ts` — UI días / horas / intervalo
- `src/bot/filters.menu.ts` — `radar_done`
- `src/jobs/queue-flush.job.ts` — `modo: 'warmup' | 'regular'`
- `src/index.ts` — tick regular + cron warmup

### 8.6 Horario digests (`/horario`, alias `/schedule`)

VIP-only. Prefs en **`UsuarioVIP`** (sobreviven Reset/Listo del radar):

| Campo | Default | Notas |
|-------|---------|--------|
| `digest_days` | L–D (1…7 ISO) | Multi-select; atajos Laborables / Toda la semana |
| `digest_start_hour` / `digest_end_hour` | 8 / 21 | Europe/Madrid. UI inicio **07–12**, fin **19–23**. Start ≠ end |
| `digest_interval_h` | **2** | Botones 1h · 2h · 3h · 4h |

**Hard floor** (env): `NOTIF_HARD_START_HOUR=7` … `NOTIF_HARD_END_HOUR=23`.  
**UX:** panel → Días · Horas · Intervalo · **Listo** (escribe BD + invalida `digest:prefs:*`). Aviso *Cambios sin guardar* hasta Listo. Tras guardar: confirmación + solo **✏️ Editar horario** (sin botón al radar — evita navegación redundante).  
**Entrypoints:** `/horario`, `/schedule`, `/start` VIP, panel post-pago, resumen en `/estado`.  
**Migración:** `prisma/migrations/20260806140000_digest_horario` (columnas `digest_*` en `usuarios_vip`).

---

## 9. Filtering UX & matching

### 9.1 User flow (`filters.menu.ts`)

Flujo actual del panel VIP (sin paso “Specs” — el campo `versions` se guarda vacío por compatibilidad schema):

1. VIP abre `/filtros` (o `/radar`) → draft desde BD.
2. **Marca** (paginada desde inventario) → selección pendiente → **✅ Aplicar**.
3. **Modelo** (o **categoría** si marca especial: Bicicletas / Remolque) → **✅ Aplicar**.
4. **Comunidad Autónoma** — solo CCAA presentes en stock, multi-select → **✅ Aplicar**.
5. **Puja máxima** — botones del contexto de stock; línea inventario:

   ```
   (Inventario: 1.200€ - 8.500€ | Media: 3.400€)
   ```
   *(Sin conteo de vehículos — solo rango y media; decisión UX para no saturar.)*

6. Panel **✅ Listo** (`radar_done`) → escribe BD + resync Redis + cadencia/warmup (§8.3 / §8.5).

**Cascade (por qué):** al cambiar un filtro superior se invalidan los inferiores para no dejar CCAA/puja de otra marca.

| Acción | Resetea |
|--------|---------|
| Aplicar / cambiar **marca** | modelo + CCAA + puja |
| Aplicar / cambiar **modelo** | CCAA + puja |
| Panel **Reset** | todo el radar en BD + cancela warmup pendiente |
| Reset por pantalla | solo ese campo (+ cascade si marca/modelo) |

**Radar “configurado”** si hay **al menos** marca, modelo, CCAA o puja (`radarIsConfigured`). Si no → Listo bloqueado con aviso.

**Pending → Aplicar:** la selección en pantalla no salta de menú hasta pulsar Aplicar (evita cambios accidentales).

### 9.2 Marcas especiales (`brand-catalog.ts`)

El inventario de embargos **no es solo coches**. Por eso hay marcas sintéticas:

| `marcaNorm` | Qué representa | “Modelos” en UI |
|-------------|----------------|-----------------|
| `bicicletas` | Bicis (eléctrica, MTB, …) | Categorías (`detectBikeCategory`) |
| `remolque` | Remolques | Carga, Portacoches, Naval, Agrícola, Otros |
| `otros` | Marcas fuera de catálogo | Catch-all para que no desaparezcan del radar |

**Por qué:** sin catch-alls, lotes reales no filtrables = mala UX VIP. Matching de bicis usa heurísticas de título/categoría, no solo igualdad `modeloNorm`.

Junk brands (piezas, inmobiliaria, etc.) se excluyen del catálogo de filtros.

### 9.3 Matching algorithm

1. Group new/updated lots by `marcaNorm::modeloNorm` (+ índices catch-all).
2. Load alerts for that slice.
3. Hard filters: brand/model (o categoría bici/remolque), `ccaaNorm`, max puja.
4. Soft tolerance on puja: +min(10%, €500) (tunable).
5. Dedupe con `NotificacionVIPEnviada` + near-dup semántico.
6. Cap **3 lots** per digest → `RPUSH` Redis.
7. Al **flush**, se **re-valida** el radar actual (lotes stale tras cambio de filtros se descartan).

**Do not** send one Telegram message per lot in realtime — digests por cadencia/usuario (§8.5).

### 9.4 Copy digests / Listo (referencia UX)

Tras **Listo**:
- Cadencia: “cada ~N min desde ahora…”
- Warmup `scheduled` → “Primer lote rápido en unos X min”
- Warmup `pending` → “Ya tienes un lote rápido en camino”
- Warmup `quota` → “envío rápido 1×/24 h… cadencia regular sí se reinició”

Cabeceras digest: normal vs **urgente** (&lt;6 h a `fecha_fin`).  
Si ≥2 lotes lookalike (misma firma, distinta matrícula/enlace) → aviso “lotes distintos”.  
Pie: “Próximo resumen según tu radar · /filtros · /horario”.

---

## 9.5 Title cleanup (`title-cleanup.job.ts`)

**Problema:** scrapers a menudo dejan `marca`/`modelo` basura o vacíos en el título.  
**Solución:** job en rol scraper cada 2 h (`15 */2 * * *`) que parsea títulos con `car-specifications.json` + reglas Bicicletas/Remolque/Otros.

| Detalle | Valor |
|---------|--------|
| Solo filas | `revisado=false` |
| Budget | `TITLE_CLEANUP_MAX_MS` (default 2 h) · batches ~80 |
| Tras fix | escribe norms + `versionTokens`; `revisado=true` |
| Desconocido | también marca `revisado=true` (**por qué:** evita bucles infinitos) |
| Retry | `TITLE_CLEANUP_RETRY_BAD=true` o `--retry-bad` |
| Post | bump Redis gen + refresh InventoryStats |

Manual: `npm run title-cleanup`.

---

## 10. AI `/asesor` (GPT-4o-mini) — reglas exactas

**Por qué gpt-4o-mini:** coste bajo, latencia OK, dominio “asesor de embargos” no necesita modelo grande.  
**Por qué cupos duros:** Telegram + OpenAI no son ilimitados; freemium sin freno = abuso.

| Cupo | Quién | Límite | Qué consume |
|------|-------|--------|-------------|
| Chat freemium | no VIP | **3 lifetime** (`ai_pruebas_usadas`) | Cada mensaje de chat |
| Chat VIP | Pagado / Cancelando | **20/día** y **140/semana** (Madrid) | Cada mensaje de chat |
| Recuperar anuncio + enlace | VIP | **3/día** (`AI_INVENTORY_DAILY_MAX`) | Solo si se entrega ficha **con** enlace |
| Alternativa enlace roto | VIP | **1/día** (`AI_BROKEN_LINK_DAILY_MAX`) | Contador aparte |
| Ficha freemium | no VIP | **1/día** (`AI_INVENTORY_DAILY_MAX_FREE`) | Ficha **sin** enlace |

- Clasificación: consejo vs recuperar vs enlace-roto (heurísticas). El **consejo no gasta** cupo de recuperación.
- Contexto: últimos **5** mensajes + resumen del radar VIP.
- Timeout: `AI_TIMEOUT_MS` (default 120 s).
- Tras `/borrar_datos` / purga 48 h: se **conserva** `telegram_id` + `ai_pruebas_usadas` (anti-abuso freemium).

Cualquier texto libre (no comando) del usuario puede ir al asesor si tiene cupo — no hace falta teclear `/asesor` cada vez (ese comando muestra ayuda).

**Product split:** el radar + digests poseen los filtros duros. La IA no reimplementa el motor de matching.

---

## 11. Monetization (Stripe) — ciclo de vida

```
Pendiente_Pago ──checkout.session.completed──▶ Pagado
     ▲                                              │
     │                         customer.subscription.updated
     │                         (cancel_at_period_end)
     │                                              ▼
     │                                         Cancelando  (sigue VIP hasta fin de periodo)
     │                                              │
     │                         customer.subscription.deleted
     │                                              ▼
     └─── purge DATA_PURGE_HOURS (48h) ──── Cancelado
          (conserva telegram_id + ai_pruebas)
```

| Pieza | Detalle |
|-------|---------|
| Payment Links | Tier1 ≤`STRIPE_TIER1_MAX` · Tier2 ≤`STRIPE_TIER2_MAX` · Tier3 resto |
| `client_reference_id` | = `telegram_id` |
| Webhooks | `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` |
| Reactivar | Si estaba `Cancelando` y vuelve a activo → otra vez `Pagado` |
| Precio en bot | **Nunca** hardcodear € — solo links Stripe |
| Contador VIP | “Cajita” editable en chat admin (`vip-counter.service` + `AppMeta`) |
| Grupo VIP | Si `TELEGRAM_GROUP_VIP_ID` → ban al pasar a Cancelado (opcional) |

**Por qué Payment Links + tiers:** soft-launch sin meter precios en código; cambiar precio = editar link en Stripe Dashboard.

---

## 12. Backup & disaster recovery

### Cloudflare R2 (activo)

1. `pg_dump` → gzip → `pg-dumps/backup-{ISO}.sql.gz` en R2
2. Retención `BACKUP_RETENTION_DAYS` (default **7**) — borra objetos antiguos del prefix
3. Éxito → solo logs; fallo → **CRITICAL** a Telegram (**nunca** el archivo dump)
4. Restore → descarga R2, `DROP SCHEMA public CASCADE`, `psql` (requiere `CONFIRM_RESTORE=YES`)

```bash
# ── Backup manual (desde el VPS) ─────────────────────────────
cd ~/Alertas_VIP_subastas
docker compose exec alertas-bot node dist/jobs/backup.job.js

# ── Restore último dump de R2 (DESTRUCTIVO) ──────────────────
docker compose stop alertas-bot
docker compose run --rm -e CONFIRM_RESTORE=YES alertas-bot node dist/jobs/restore.job.js
# Opcional: dump concreto
# docker compose run --rm -e CONFIRM_RESTORE=YES \
#   -e RESTORE_KEY=pg-dumps/backup-2026-08-03T08-32-39-139Z.sql.gz \
#   alertas-bot node dist/jobs/restore.job.js
docker compose up -d alertas-bot
```

Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `BACKUP_RETENTION_DAYS`, `BACKUP_CRON`, `CONFIRM_RESTORE`, `RESTORE_KEY`

---

## 13. Admin Telegram policy

| Variable | Uso |
|----------|-----|
| `TELEGRAM_ADMIN_CHAT_ID` | Chat/grupo donde llegan alertas **CRITICAL** (fallos graves) |
| `TELEGRAM_ADMIN_USER_IDS` | User id(s) numéricos positivos (coma-separados). Obligatorio para comandos admin |

`sendCriticalAlert` **solo** para:

- Fallo de arranque de la app
- `uncaughtException` / `unhandledRejection`
- Crash de ciclo de scrapers
- Fallos de backup / restore R2

Formato: HTML, cooldown anti-spam (`ADMIN_ALERT_COOLDOWN_MS`, default 15 min). El texto se **redacta** (sin tokens/claves) antes de enviar.

**Nunca** enviar dumps de BD a Telegram.

Comando oculto `/get_topic_id`: **solo** si `ctx.from.id` ∈ `TELEGRAM_ADMIN_USER_IDS`. Cualquier otro usuario → silencio (sin pista).

### 13.1 Bot commands (matriz)

| Comando | Quién | Qué hace |
|---------|-------|----------|
| `/start` | Todos | Menú + botones (pago / estado / filtros / horario / legal / canal) |
| `/filtros` · `/radar` | VIP (Pagado/Cancelando) | Panel radar |
| `/horario` · `/schedule` | VIP | Días, horas e intervalo de resúmenes |
| `/asesor` | Todos | Ayuda IA + cupos |
| `/estado` | Todos | Suscripción + filtros + resumen `/horario` |
| `/borrar_datos` | Solo `Cancelado` | Purga personal; conserva id + freemium IA |
| Texto libre | Con cupo | Chat asesor |
| `/vip_count` | Admin | Refresca cajita contador VIP |
| `/get_topic_id` | Admin | Id de topic/hilo |
| `/help` · `/comandos` | Admin chat | Lista cmds admin; resto silencio |

**Nota canales:** en canales/grupos el menú `/` de Telegram a menudo no aparece — preferir **grupo privado** admin o teclear comandos a mano.

Rate-limit Telegram texto: ~**6 msgs / 1.5 s** (callbacks exentos).

---

## 14. Security layers (soft-launch)

Capas activas en código + Compose. Objetivo: superficie mínima, sin root en la app, secretos fuera de logs/chat, DB/Redis no expuestos a Internet.

| Service | Role | Exposure |
|---------|------|----------|
| `alertas-bot` | Bot + matching + digests + Stripe webhook + backup | `127.0.0.1:3002` + red NPM |
| `alertas-scraper` | Scrapers + inventory stats post-scrape | Solo red `internal` (sin ports, sin NPM) |
| `postgres` | Source of truth | Solo red `internal` (sin `ports:`) |
| `redis` | Cache + digest queues | Solo red `internal` (sin `ports:`) |

### 14.1 Network & reverse proxy

| Capa | Qué hace |
|------|----------|
| Bind app | Solo `127.0.0.1:3002:3002` — nunca `0.0.0.0` en el host |
| Postgres / Redis | **Sin** `ports:` — solo red Docker `internal` |
| NPM | HTTPS + Let's Encrypt delante; Destination = nombre del contenedor `alertas-vip-subastas-bot:3002` |
| Redes | `internal` (bot↔scraper↔db↔redis) + `npm_proxy` externa solo para el bot |
| Scraper secrets | Sin `env_file` completo: solo `DATABASE_URL` / `REDIS_URL` / knobs scraper |
| Admin UI | NPM `:81` y Prisma Studio solo por **túnel SSH**, no por IP pública |

### 14.2 Container hardening

| Servicio | Usuario | Privilegios |
|----------|---------|-------------|
| `alertas-bot` | `pwuser` (uid **1000**) | `cap_drop: ALL`, `no-new-privileges`, `ipc: private`, `deploy.resources.limits.pids: 256` |
| `alertas-scraper` | `pwuser` (uid **1000**) | `cap_drop: ALL`, `no-new-privileges`, `ipc: private`, `pids: 512` |
| `postgres` | Usuario `postgres` de la imagen oficial | `cap_drop: ALL` + caps mín. init, `ipc: private`, `pids: 200`, `no-new-privileges` |
| `redis` | Usuario `redis` de la imagen oficial | `no-new-privileges`, `ipc: private`, `pids: 128` (sin `cap_drop: ALL`: rompe AOF) |

- Sin `docker.sock`, sin `network_mode: host`, sin Prisma Studio en el stack de prod.
- Chromium (si se usa): `--no-sandbox` / `--disable-setuid-sandbox` (necesario sin root).
- Verificación: `docker compose exec alertas-bot id` → `uid=1000(pwuser)`.

### 14.3 Secrets & logging

| Capa | Qué hace |
|------|----------|
| `.env` | Fuera de git; passwords fuertes en Postgres/Redis; `chmod 600` en el VPS |
| Logger Winston | `redactSecrets()` enmascara bot tokens, `sk_live`/`sk_test`, `whsec_`, OpenAI keys, user:pass en URLs, assignments de env sensibles |
| CRITICAL Telegram | Pasa por la misma redacción antes de enviar |
| Stripe errors | Se loguea el mensaje, no el objeto crudo del error |
| Redis healthcheck | `redis-cli -a $$REDIS_PASSWORD ping \| grep PONG` (auth real; password solo en env del contenedor) |

**Nunca** pegar claves en chats de soporte ni en issues. Si un secreto se filtró, rotarlo.

### 14.4 HTTP surface (Express)

| Ruta | Comportamiento |
|------|----------------|
| `GET /health` | Solo `{ "status": "ok" }` — sin redis/inventario/memoria/jobs |
| Stripe webhook RL | Rate-limit por IP (`STRIPE_WEBHOOK_RATE_LIMIT_*`, default 60/min) |
| `POST /webhook/stripe` | Body **raw** (`express.raw`), firma Stripe obligatoria (`STRIPE_WEBHOOK_SECRET`), rechaza sin signature / body inválido |
| Resto | `404` genérico; errores `500` sin stack al cliente |
| Headers | `x-powered-by` desactivado; `trust proxy` para NPM |

### 14.5 Data / product security

| Tema | Política |
|------|----------|
| Bright Data | **Eliminado del código** — no hay integración activa |
| Schema boot | `prisma migrate deploy` vía `migrate-boot` (baseline automático si la DB venía de `db push`) |
| Restore | Exige `CONFIRM_RESTORE=YES`; dump nunca a Telegram |
| Radar VIP | Al cambiar filtros (fingerprint): sobrescribe BD → vacía cola Redis → reseeding |
| Cambio de marca | Reinicia modelo (UI + defensa en guardado/matching) |
| Flush digests | Cadencia **por VIP** vía `/horario` (1–4 h, default 2) + warmup 5–15 min (cuota 24 h); hard floor 7–23; descarta lotes fuera de radar |
| `/borrar_datos` | Solo estado `Cancelado` (VIP terminado); purga filtros/msgs/email; **conserva** `telegram_id` + cupo freemium IA (anti-abuso) |
| Auto-purga | `DATA_PURGE_HOURS` (default **48**) tras `Cancelado` |
| IA cupos | Freemium **3 lifetime**; VIP chat 20/día·140/sem; recovery 3/día; broken 1/día; free ficha 1/día sin enlace |
| Console | `installRedactedConsole()` enmascara secretos también en `console.*` |
| Ops reminder | Cron mensual (`OPS_REMINDER_CRON`) — deps + drill restore |

### 14.6 VPS host (checklist operativo)

Complemento fuera de Compose (verificar en el servidor):

- SSH con clave; evitar password login en root si aplica
- UFW: solo 22 / 80 / 443 (y lo mínimo necesario)
- fail2ban activo
- NPM admin **no** expuesto en IP pública (túnel SSH)
- `.env` con `chmod 600`

### 14.7 NPM — Proxy Host (Subastas)

| Campo | Valor correcto |
|-------|----------------|
| Domain Names | `alertassubastas.florianserb.com` (con **doble s**) |
| Scheme | `http` |
| Forward Hostname / IP | `alertas-vip-subastas-bot` (**nombre del contenedor**) |
| Forward Port | `3002` |
| SSL | Let's Encrypt + Force SSL |
| Webhook Stripe | `https://alertassubastas.florianserb.com/webhook/stripe` |

> Si tienes `127.0.0.1:3002` como Destination, cámbialo al nombre del contenedor. `127.0.0.1` dentro de NPM apunta al propio contenedor NPM, no al host.

### 14.8 Acceso admin por túnel SSH (Windows PowerShell)

**Nginx Proxy Manager** → **http://localhost:8181**

```powershell
C:\Windows\System32\OpenSSH\ssh.exe -i $env:USERPROFILE\.ssh\id_ed25519_vps -L 8181:127.0.0.1:81 florian@46.225.172.167
```

**Prisma Studio** (si lo levantas en el VPS en `127.0.0.1:5555`) → **http://localhost:5555**

```powershell
C:\Windows\System32\OpenSSH\ssh.exe -i $env:USERPROFILE\.ssh\id_ed25519_vps -L 5555:127.0.0.1:5555 florian@46.225.172.167
```

No abras `:81` ni Studio por la IP pública.

### 14.9 Checklist de controles (verificable)

Ejecutar en el VPS tras deploy. Cada fila = control + comando esperado.

| # | Control | Cómo verificar | Esperado |
|---|---------|----------------|----------|
| 1 | App non-root | `docker compose exec alertas-bot id` | `uid=1000(pwuser)` |
| 2 | Scraper non-root | `docker compose exec alertas-scraper id` | `uid=1000(pwuser)` |
| 3 | `no-new-privileges` | `docker inspect alertas-vip-subastas-bot --format '{{.HostConfig.SecurityOpt}}'` | contiene `no-new-privileges` |
| 4 | `cap_drop` app | `docker inspect alertas-vip-subastas-bot --format '{{.HostConfig.CapDrop}}'` | `[ALL]` o `ALL` |
| 5 | `ipc: private` | `docker inspect alertas-vip-subastas-bot --format '{{.HostConfig.IpcMode}}'` | `private` |
| 6 | `pids` limit | `docker inspect alertas-vip-subastas-bot --format '{{.HostConfig.PidsLimit}}'` | `256` (scraper `512`) |
| 7 | Bind localhost | `sudo ss -tulpn \| grep 3002` | `127.0.0.1:3002` |
| 8 | DB/Redis sin ports | `sudo ss -tulpn \| grep -E '5432\|6379'` | vacío (o no públicos) |
| 9 | Redes | `docker inspect alertas-vip-subastas-bot --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}'` | `internal` + red NPM |
| 10 | Scraper sin NPM | igual para `alertas-scraper` | solo `internal` |
| 11 | Health slim | `curl -sS https://alertassubastas.florianserb.com/health` | `{"status":"ok"}` |
| 12 | Migraciones | `docker compose exec alertas-bot npx prisma migrate status` | Database schema is up to date |
| 13 | Smoke | `docker compose exec alertas-bot npm run verify:system` | exit 0 + OK al admin |
| 14 | Scraper healthy | `docker compose ps alertas-scraper` | `healthy` (PID 1 = Node) |
| 15 | Scraper sin Stripe | `docker compose exec alertas-scraper printenv STRIPE_SECRET_KEY` | vacío |
| 16 | Logs sin secretos | `docker compose logs alertas-bot --tail 100 \| grep -E 'sk_live\|whsec_\|sk-proj'` | sin matches |
| 17 | Ops reminder | `docker compose exec alertas-bot npm run ops:reminder` | mensaje admin (manual) |

### 14.10 Verificación rápida (atajo)

```bash
cd ~/Alertas_VIP_subastas
docker compose exec alertas-bot id
docker compose exec alertas-bot npx prisma migrate status
curl -sS https://alertassubastas.florianserb.com/health
docker compose exec alertas-bot npm run verify:system
```

### 14.11 Rotar password Postgres (volumen ya existente)

```bash
cd ~/Alertas_VIP_subastas
chmod 600 .env
bash scripts/rotate-postgres-password.sh
docker compose up -d --build --force-recreate
```

**Boot (compose):** wait for Postgres health → `node dist/scripts/migrate-boot.js` (`migrate deploy` + baseline legacy) → `node dist/index.js`.

---

## 15. Environment variables (names only)

**Core:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_ADMIN_USER_IDS`, `TELEGRAM_CHANNEL_PUBLICO_ID`, `TELEGRAM_GROUP_VIP_ID`, `TELEGRAM_ADMIN_TOPIC_ID`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `REDIS_URL`, `REDIS_PASSWORD`, `OPENAI_API_KEY`, `PORT`, `APP_ROLE`, `LOG_LEVEL`

**Stripe:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PAYMENT_LINK_TIER1`…, `STRIPE_BILLING_PORTAL_URL`, `STRIPE_TIER1_MAX`, `STRIPE_TIER2_MAX`

**Notifications / purge:** `NOTIFIER_INTERVAL_MINUTES` (=120 seed), `NOTIFIER_TICK_MINUTES` (=5), `NOTIFIER_LOOKBACK_MINUTES`, `MATCHING_INTERVAL_MINUTES` (=30), `NOTIF_HARD_START_HOUR` / `NOTIF_HARD_END_HOUR` (7–23), `NOTIF_WINDOW_START_HOUR` / `NOTIF_WINDOW_END_HOUR` (8–21 defaults), `DIGEST_WARMUP_*`, `NOTIF_MAX_*`, `NOTIF_SEND_DELAY_MS`, `DATA_PURGE_HOURS` (=48), `CLEANUP_HORAS_TELEGRAM`

**Scrapers:** `SCRAPER_CRON`, `SCRAPER_STEADY_ONLY`, `SCRAPER_STEADY_PAGES`, `SCRAPER_WINDOW_SIZE`, `REQUEST_DELAY_MS`, `MAX_RETRIES`, `TITLE_CLEANUP_MAX_MS`, `TITLE_CLEANUP_RETRY_BAD`

**Public:** `MAX_PUBLICACIONES_PUBLICAS_DIARIAS` (=1). Horario **fijo** en código: `PUBLIC_CHANNEL_CRON=0 10 * * *` · `Europe/Madrid` (`notifier.job.ts`).

**AI:** `AI_VIP_DAILY_MAX`, `AI_VIP_WEEKLY_MAX`, `AI_INVENTORY_DAILY_MAX`, `AI_INVENTORY_DAILY_MAX_FREE`, `AI_BROKEN_LINK_DAILY_MAX`, `AI_TIMEOUT_MS`

**R2:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `BACKUP_RETENTION_DAYS`, `BACKUP_CRON`, `CONFIRM_RESTORE`, `RESTORE_KEY`

**Ops / verify:** `OPS_REMINDER_CRON`, `VERIFY_HEALTH_URL`, `VERIFY_SKIP_HTTP`, `ADMIN_ALERT_COOLDOWN_MS`, `NPM_NETWORK`

**Timezone:** Compose fuerza `TZ=Europe/Madrid` en `alertas-bot` y `alertas-scraper` (crons + `/horario`).

---

## 16. Product / UX decisions (locked) — el “por qué”

| Decision | Por qué |
|----------|---------|
| Digests ~**2 h/usuario** (1–4 vía `/horario`) + warmup 5–15 min (**1×/24 h**) | UX premium sin spam; re-Aplicar no acelera el lote rápido |
| `/horario` por VIP (días + horas + intervalo); hard floor **7–23** | Noches libres para cleanup/backup; el usuario controla la cadencia |
| Tras guardar `/horario`: solo **Editar horario** | Sin botón al radar (navegación redundante desde ese contexto) |
| Aplicar filtros **ilimitado** | El usuario debe poder afinar el radar; solo se limita el warmup |
| Warmup **no** mueve `next_regular` | Reloj regular estable; anti-abuso limpio |
| Canal FOMO **10:00 Madrid**, 1×/día, **sin enlace**, lotes 3–24 h | Conversión predecible; no competir con digests VIP |
| Dual `app`/`scraper` | Aislar Playwright + secretos; scrapers no tumban el bot |
| Inventory-backed filters only | Sin CCAA/marcas muertas |
| Stock line sin conteo | Transparencia de precios sin ruido |
| Cascade marca→modelo→CCAA/puja | Evita filtros stale tras cambiar marca |
| Marcas Bicicletas / Remolque / Otros | Inventario real ≠ solo coches |
| Title-cleanup + `revisado` | Títulos sucios de subasta; sin bucles |
| Cancelando = sigue VIP hasta fin periodo | Honestidad con lo pagado en Stripe |
| Conservar `telegram_id` tras purga | Anti-abuso freemium IA |
| Payment Links por tiers | Precio fuera del código |
| R2 no Telegram para dumps | Profesional + seguro |
| Bright Data **off / eliminado** | Coste; scrapers HTTP/API suficientes |
| Honest copy | No “ilimitado” / “al segundo exacto” |
| Specs step **retirado** de UI | Complejidad vs valor; `versions[]` vacío por compat |

---

## 17. Estado de implementación

Las fases 0–7 del roadmap original están **entregadas** en producción. Detalle vivo en **§24 Checklist maestra**.

| Área | Estado |
|------|--------|
| Infra dual + Redis fail-open + healthchecks | ✅ |
| Scrapers 4 portales + title-cleanup + marcas especiales | ✅ |
| Radar VIP + matching + digests `/horario` + warmup | ✅ |
| Warmup cuota 24 h + canal 10:00 Madrid | ✅ |
| Stripe Live + ciclo Cancelando | ✅ |
| IA cupos exactos | ✅ |
| R2 + ops reminder + CI migrate/Docker | ✅ |
| Seguridad soft-launch (§14) | ✅ |
| Smoke E2E VPS (`verify:system` + flujo VIP `/horario`) | ✅ (2026-08-06) |
| Textos legales | ✅ PDF publicado + enlace `/start` (6 ago 2026) |

---

## 18. Common change recipes

### Change digest frequency / hours / days
VIP: `/horario` (o botón **⏰ Horario de resúmenes** en `/start` / panel post-pago). Guarda en `UsuarioVIP.digest_*`.
Ops defaults / hard floor: `.env` → `NOTIFIER_INTERVAL_MINUTES` (seed), `NOTIF_WINDOW_*`, `NOTIF_HARD_*`, `NOTIFIER_TICK_MINUTES` → rebuild/restart.
Warmup: `DIGEST_WARMUP_MIN_MINUTES` / `DIGEST_WARMUP_MAX_MINUTES` / `DIGEST_WARMUP_QUOTA_HOURS`.
Matching VIP: `MATCHING_INTERVAL_MINUTES`. Canal público: horario fijo en código (§6), no configurable por env.

### Change scraper windows
Scraper state manager + `SCRAPER_STEADY_PAGES` / `SCRAPER_WINDOW_SIZE`.

### Add a portal
New scraper → validate/sanitize/norms → hook job → prefer page-window state.

### Tighten matching
`matching.service.ts` hard/soft rules.

### Schema change
Edit `prisma/schema.prisma` → `npx prisma migrate dev --name <desc>` → commit `prisma/migrations` → deploy aplica `migrate deploy` en boot.

### Wrong-brand digests after filter change
Confirm alert row → save filters again (auto-clear queue) → check `notif:q:{id}`. Al cambiar **marca**, el modelo se reinicia.

---

## 19. Ops cheat sheet

```bash
docker compose up --build -d
docker compose logs -f alertas-bot
docker compose logs -f alertas-scraper
docker compose exec alertas-bot npm run verify:system
docker compose exec alertas-bot npm run backup
```

**Roles:** `APP_ROLE=app` (bot + Stripe + digests) · `APP_ROLE=scraper` (solo inventario) · `all` en local/dev.

**Local:** Postgres + Redis via Compose; `npm run dev`; ngrok → Stripe webhook en `PORT` **3002**.

**Prisma Studio (VPS, solo localhost):**
```bash
docker compose run --rm -p 127.0.0.1:5555:5555 alertas-bot npx prisma studio --hostname 0.0.0.0 --port 5555
```
Luego túnel SSH → http://localhost:5555 (§14.8).
---

## 20. Legal & privacy (product)

### Qué hay hoy
- **Texto legal:** [`LEGAL.md`](./LEGAL.md) + PDF en Drive (botón `/start`): https://drive.google.com/file/d/1bvrTFHAeF_tJroPTItDrdlWxVNmaVWd2/view?usp=sharing (fecha doc: **6 ago 2026**).
- **Almacenamiento:** Telegram id, estado suscripción, Stripe customer id, email opcional, filtros, horario digests, historial notificaciones (dedup), cupos IA.
- **No** se guardan datos de tarjeta (Stripe).
- **`/borrar_datos`:** solo cuando VIP ha **terminado** (`Cancelado`); purga filtros/mensajes/email; **conserva** `telegram_id` + `ai_pruebas_usadas`. Auto-purga tras `DATA_PURGE_HOURS` (48 h).
- **RGPD scraping:** sanitización DNI/CIF (`sanitizer.ts`).
- El servicio **relaciona información pública** de subastas; no garantiza adjudicación.
- **Sin reembolsos** tras cobro (suscripción o renovación) — ver `LEGAL.md` §C6.

### Pendiente
- (Opcional) Hospedar el PDF en dominio propio además de Drive.

---

## 21. Glossary

| Term | Meaning |
|------|---------|
| **Norm** | Canonical lowercase brand/model/CCAA key for indexes |
| **Digest** | One Telegram message with ≤3 matched auction lots |
| **Warmup** | Primer lote 5–15 min tras Listo (cuota 1×/24 h); no mueve cadencia regular |
| **Horario** (`/horario`) | Prefs VIP: días + horas + intervalo 1–4 h; hard floor 7–23 Europe/Madrid |
| **Hard floor** | `NOTIF_HARD_*`: techo del sistema; `/horario` no puede salir de ahí |
| **Listo** | Confirma radar en BD (`radar_done`); reinicia cadencia + intenta warmup |
| **Aplicar** | Confirma un campo del draft (marca/modelo/CCAA/puja) sin salir aún |
| **Slice** | `marcaNorm::modeloNorm` grouping for matching |
| **InventoryStats** | Precomputed aggregates for filter UX (post-scrape) |
| **Page window** | Discovery bands → steady first 5 pages |
| **Flexible Match** | Soft tolerance on max starting bid |
| **FOMO público** | Canal 10:00, sin enlace, 3–24 h a cierre |
| **Cancelando** | VIP hasta fin de periodo Stripe (sigue digests) |
| **revisado** | Flag title-cleanup (ya procesado) |

---

## 22. Known gaps / future work

- Near-dup cross-portal (prioridad baja)
- “Vs media inventario” solo si n≥X
- Transcripción voz (OpenAI) — V2
- Tests unitarios automatizados (smoke manual VPS ✅ 2026-08-06)
- (Opcional) Hospedar PDF legal en dominio propio
- **No** reactivar Bright Data; **no** ocultar portal en digests

---

## 23. Adaptaciones inmobiliario → subastas (estado)

### Portado / cerrado
Warmup (cuota 24 h) · `/horario` (días/horas/intervalo; conf. solo Editar) · cadencia 1–4 h/usuario · TZ Europe/Madrid · split app/scraper · verify+CI (typecheck + migrate + Docker build) · health slim + scraper healthcheck · Stripe RL · `migrate deploy` · checklist §14.9 · reset cascade marca/modelo · pitch ES · `installRedactedConsole` · reminder mensual ops · canal 10:00 Madrid · smoke E2E VPS 2026-08-06.

### No portar
Bright Data · ocultar portal · Tailscale/UFW (ya en VPS) · % chollo inmobiliario · paso Specs del radar inmobiliario.

---

## 24. Checklist maestra — completado vs pendiente

> SSOT de “qué está hecho”. Actualizar al cerrar tareas.

### ✅ Completado

| # | Área | Detalle |
|---|------|---------|
| 1 | Infra | Dual containers, Postgres 16, Redis 7, non-root, cap_drop, healthchecks bot+scraper |
| 2 | Scrapers | BOE / Escrapalia / eActivos HTTP / Procuradores · steady windows |
| 3 | Inventario | Sanitizer RGPD/CCAA · norms · title-cleanup · Bicicletas/Remolque/Otros |
| 4 | Radar VIP | Marca→modelo→CCAA→puja · cascade · fingerprint resync |
| 5 | Matching | Cola Redis ≤3 · urgencia &lt;6h · lookalike · re-validación al flush |
| 6 | Digests | `/horario` por VIP · cadencia 1–4 h (default 2) · warmup 5–15 (1×/24 h) · hard floor 7–23 · debounce 90 s |
| 7 | Canal público | 10:00 Madrid · 1×/día · sin enlace · elegibles 3–24 h |
| 8 | IA | Cupos exactos §10 · freemium lifetime 3 · VIP 20/140 |
| 9 | Stripe | Links tiered · webhooks · Cancelando→Cancelado · contador VIP |
| 10 | Privacidad técnica | `/borrar_datos` · purga 48 h · conservar id |
| 11 | Backup | R2 · retención 7 d · `CONFIRM_RESTORE=YES` |
| 12 | Seguridad | Redacción logs · health slim · §14.9 · ops reminder |
| 13 | CI | Typecheck + audit + migrate deploy + Docker build |
| 14 | Docs | Este README + `.env.example` + decisiones §16 |
| 15 | `/horario` | Prefs en UsuarioVIP · UI ES · hard floor 7–23 · TZ Madrid · conf. solo «Editar horario» |
| 16 | Smoke E2E | VPS 2026-08-06: 4 servicios healthy + `verify:system` OK + flujo VIP `/horario` validado |
| 17 | Legales | PDF Drive actualizado + botón `/start` · `LEGAL.md` en repo |

### ⏳ Pendiente

| # | Prioridad | Tarea |
|---|-----------|-------|
| 1 | Baja | (Opcional) PDF en dominio propio · tests unitarios · near-dup · voz V2 |

### Smoke E2E (referencia; pasado ✅ 2026-08-06)

```bash
docker compose ps && docker compose exec -T alertas-bot npm run verify:system
```

Checklist manual Telegram (también validado en soft-launch):

1. `docker compose ps` → bot + scraper + postgres + redis **healthy**
2. `verify:system` → env / postgres / redis / health **OK**
3. `/start` → legal link · `/estado` · VIP
4. `/filtros` → marca→modelo→CCAA→puja → **Listo** → warmup/cadencia
5. `/horario` → días/horas/intervalo → **Listo** → solo **Editar horario** · visible en `/estado`
6. Warmup o `npm run flush-queue` / logs digest
7. `/asesor` + cupos
8. Canal público 10:00 (o `npm run notifier`)
9. Backup: `npm run backup` (restore solo en staging)

---

*Soft-launch producto ✅ · `/horario` + digests + dual containers + R2 + CI + legales publicados (§20).*