-- AlterTable
ALTER TABLE "usuarios_vip" ADD COLUMN IF NOT EXISTS "ai_broken_uso_diario" INTEGER NOT NULL DEFAULT 0;
