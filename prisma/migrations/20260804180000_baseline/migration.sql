-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "vehiculos" (
    "id_subasta" TEXT NOT NULL,
    "id_lote" TEXT NOT NULL DEFAULT '',
    "portal" TEXT NOT NULL,
    "enlace" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "marca" TEXT NOT NULL DEFAULT '',
    "modelo" TEXT NOT NULL DEFAULT '',
    "marcaNorm" TEXT NOT NULL DEFAULT '',
    "modeloNorm" TEXT NOT NULL DEFAULT '',
    "versionTokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ccaaNorm" TEXT NOT NULL DEFAULT '',
    "puja_minima" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fecha_inicio" TEXT,
    "fecha_fin" TIMESTAMP(3),
    "provincia" TEXT,
    "comunidad_autonoma" TEXT,
    "publicado_publico" BOOLEAN NOT NULL DEFAULT false,
    "publicado_vip" BOOLEAN NOT NULL DEFAULT false,
    "telegram_message_id_publico" INTEGER,
    "telegram_message_id_vip" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehiculos_pkey" PRIMARY KEY ("id_subasta","id_lote","portal")
);

-- CreateTable
CREATE TABLE "usuarios_vip" (
    "id" SERIAL NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "email" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'Pendiente_Pago',
    "stripe_customer_id" TEXT,
    "ai_pruebas_usadas" INTEGER NOT NULL DEFAULT 0,
    "ai_uso_diario" INTEGER NOT NULL DEFAULT 0,
    "ai_uso_semanal" INTEGER NOT NULL DEFAULT 0,
    "ai_inv_uso_diario" INTEGER NOT NULL DEFAULT 0,
    "ai_inv_clave_dia" TEXT NOT NULL DEFAULT '',
    "ai_clave_dia" TEXT NOT NULL DEFAULT '',
    "ai_clave_semana" TEXT NOT NULL DEFAULT '',
    "vip_ended_at" TIMESTAMP(3),
    "datos_purgados_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "cancel_at" TIMESTAMP(3),

    CONSTRAINT "usuarios_vip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scraper_log" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "vehiculos_encontrados" INTEGER NOT NULL DEFAULT 0,
    "vehiculos_nuevos" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "duracion_ms" INTEGER,
    "ejecutado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scraper_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios_filtros" (
    "telegram_id" TEXT NOT NULL,
    "tipos" TEXT NOT NULL DEFAULT '[]',
    "comunidades" TEXT NOT NULL DEFAULT '[]',
    "puja_maxima" DOUBLE PRECISION,
    "origenes" TEXT NOT NULL DEFAULT '[]',
    "etiquetas" TEXT NOT NULL DEFAULT '[]',
    "estados" TEXT NOT NULL DEFAULT '[]',
    "marcaNorm" TEXT,
    "modeloNorm" TEXT,
    "versions" TEXT NOT NULL DEFAULT '[]',
    "ccaaNorms" TEXT NOT NULL DEFAULT '[]',
    "fingerprint" TEXT,

    CONSTRAINT "usuarios_filtros_pkey" PRIMARY KEY ("telegram_id")
);

-- CreateTable
CREATE TABLE "notificaciones_vip_enviadas" (
    "id" SERIAL NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "id_subasta" TEXT NOT NULL,
    "id_lote" TEXT NOT NULL DEFAULT '',
    "portal" TEXT NOT NULL,
    "telegram_message_id" INTEGER NOT NULL DEFAULT 0,
    "enviado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificaciones_vip_enviadas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stats" (
    "id" SERIAL NOT NULL,
    "marcaNorm" TEXT NOT NULL,
    "modeloNorm" TEXT NOT NULL DEFAULT '',
    "versionToken" TEXT NOT NULL DEFAULT '',
    "ccaaNorm" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,
    "pujaMin" DOUBLE PRECISION,
    "pujaMax" DOUBLE PRECISION,
    "pujaAvg" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scraper_state" (
    "portal" TEXT NOT NULL,
    "nextWindowStart" INTEGER NOT NULL DEFAULT 1,
    "fullyCrawled" BOOLEAN NOT NULL DEFAULT false,
    "lastPageSeen" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scraper_state_pkey" PRIMARY KEY ("portal")
);

-- CreateIndex
CREATE INDEX "vehiculos_portal_idx" ON "vehiculos"("portal");

-- CreateIndex
CREATE INDEX "vehiculos_publicado_publico_idx" ON "vehiculos"("publicado_publico");

-- CreateIndex
CREATE INDEX "vehiculos_publicado_vip_idx" ON "vehiculos"("publicado_vip");

-- CreateIndex
CREATE INDEX "vehiculos_marca_idx" ON "vehiculos"("marca");

-- CreateIndex
CREATE INDEX "vehiculos_marcaNorm_modeloNorm_idx" ON "vehiculos"("marcaNorm", "modeloNorm");

-- CreateIndex
CREATE INDEX "vehiculos_ccaaNorm_idx" ON "vehiculos"("ccaaNorm");

-- CreateIndex
CREATE INDEX "vehiculos_fecha_fin_idx" ON "vehiculos"("fecha_fin");

-- CreateIndex
CREATE INDEX "vehiculos_puja_minima_idx" ON "vehiculos"("puja_minima");

-- CreateIndex
CREATE INDEX "vehiculos_updated_at_idx" ON "vehiculos"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_vip_telegram_id_key" ON "usuarios_vip"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_vip_stripe_customer_id_key" ON "usuarios_vip"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "usuarios_vip_estado_idx" ON "usuarios_vip"("estado");

-- CreateIndex
CREATE INDEX "usuarios_vip_email_idx" ON "usuarios_vip"("email");

-- CreateIndex
CREATE INDEX "usuarios_filtros_marcaNorm_modeloNorm_idx" ON "usuarios_filtros"("marcaNorm", "modeloNorm");

-- CreateIndex
CREATE INDEX "notificaciones_vip_enviadas_telegram_id_idx" ON "notificaciones_vip_enviadas"("telegram_id");

-- CreateIndex
CREATE INDEX "notificaciones_vip_enviadas_id_subasta_id_lote_portal_idx" ON "notificaciones_vip_enviadas"("id_subasta", "id_lote", "portal");

-- CreateIndex
CREATE UNIQUE INDEX "notificaciones_vip_enviadas_telegram_id_id_subasta_id_lote__key" ON "notificaciones_vip_enviadas"("telegram_id", "id_subasta", "id_lote", "portal");

-- CreateIndex
CREATE INDEX "inventory_stats_marcaNorm_modeloNorm_idx" ON "inventory_stats"("marcaNorm", "modeloNorm");

-- CreateIndex
CREATE INDEX "inventory_stats_ccaaNorm_idx" ON "inventory_stats"("ccaaNorm");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stats_marcaNorm_modeloNorm_versionToken_ccaaNorm_key" ON "inventory_stats"("marcaNorm", "modeloNorm", "versionToken", "ccaaNorm");

-- AddForeignKey
ALTER TABLE "usuarios_filtros" ADD CONSTRAINT "usuarios_filtros_telegram_id_fkey" FOREIGN KEY ("telegram_id") REFERENCES "usuarios_vip"("telegram_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notificaciones_vip_enviadas" ADD CONSTRAINT "notificaciones_vip_enviadas_telegram_id_fkey" FOREIGN KEY ("telegram_id") REFERENCES "usuarios_vip"("telegram_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notificaciones_vip_enviadas" ADD CONSTRAINT "notificaciones_vip_enviadas_id_subasta_id_lote_portal_fkey" FOREIGN KEY ("id_subasta", "id_lote", "portal") REFERENCES "vehiculos"("id_subasta", "id_lote", "portal") ON DELETE CASCADE ON UPDATE CASCADE;

