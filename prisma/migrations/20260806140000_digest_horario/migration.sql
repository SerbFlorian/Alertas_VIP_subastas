-- Horario de digests por VIP (/horario)
ALTER TABLE "usuarios_vip" ADD COLUMN IF NOT EXISTS "digest_days" INTEGER[] DEFAULT ARRAY[1,2,3,4,5,6,7]::INTEGER[];
ALTER TABLE "usuarios_vip" ADD COLUMN IF NOT EXISTS "digest_start_hour" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "usuarios_vip" ADD COLUMN IF NOT EXISTS "digest_end_hour" INTEGER NOT NULL DEFAULT 21;
ALTER TABLE "usuarios_vip" ADD COLUMN IF NOT EXISTS "digest_interval_h" INTEGER NOT NULL DEFAULT 2;
