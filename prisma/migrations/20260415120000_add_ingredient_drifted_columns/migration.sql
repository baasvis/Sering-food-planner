-- Reconciles schema drift: these columns existed on production (added via
-- `prisma db push` and reflected in schema.prisma) but were never committed
-- as a migration, so staging was missing them. IF NOT EXISTS makes this safe
-- to run against both environments.

ALTER TABLE "ingredients"
  ADD COLUMN IF NOT EXISTS "order_unit_size" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "ingredients"
  ADD COLUMN IF NOT EXISTS "price_per_100" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "ingredients"
  ADD COLUMN IF NOT EXISTS "measure_mode" TEXT NOT NULL DEFAULT 'weight';

ALTER TABLE "ingredients"
  ADD COLUMN IF NOT EXISTS "target_stock" JSONB NOT NULL DEFAULT '{}'::jsonb;
