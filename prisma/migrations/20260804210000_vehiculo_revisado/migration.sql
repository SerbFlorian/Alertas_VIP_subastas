-- AlterTable
ALTER TABLE "vehiculos" ADD COLUMN IF NOT EXISTS "revisado" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "vehiculos_revisado_idx" ON "vehiculos"("revisado");
