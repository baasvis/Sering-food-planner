-- Unified-batch-inventory drop_cols (manual psql step at deploy time).
-- APPLY ONLY AFTER `npm run migrate:data-migrate` has completed
-- successfully against the same DB. See DEPLOY.md Step 5 for the full
-- sequence + ordering rationale.
--
-- This file lives at `prisma/migrations/drop-cols.sql` (top level of the
-- migrations folder) on purpose: Prisma's migration loader scans for
-- `<ts>_<name>/migration.sql` and will NOT pick this up — preventing
-- Railway's auto-deploy from applying it before the data-migrate step.
--
-- Order matters: drop FK before dropping the column it references; drop
-- indexes before dropping the indexed column (Postgres allows DROP COLUMN
-- to cascade, but explicit is safer for review).

-- 1. Drop the parent_id self-FK (constraint added by 20260409120000_add_indexes_and_parent_fk).
ALTER TABLE "batches" DROP CONSTRAINT IF EXISTS "batches_parent_id_fkey";

-- 2. Drop indexes on legacy columns.
DROP INDEX IF EXISTS "batches_parent_id_idx";
DROP INDEX IF EXISTS "batches_location_idx";

-- 3. Drop legacy columns.
ALTER TABLE "batches" DROP COLUMN IF EXISTS "parent_id";
ALTER TABLE "batches" DROP COLUMN IF EXISTS "location";
ALTER TABLE "batches" DROP COLUMN IF EXISTS "stock";
ALTER TABLE "batches" DROP COLUMN IF EXISTS "storage";
ALTER TABLE "batches" DROP COLUMN IF EXISTS "in_transit";
ALTER TABLE "batches" DROP COLUMN IF EXISTS "recipe_sheet_id";
ALTER TABLE "batches" DROP COLUMN IF EXISTS "recipe_volume";
ALTER TABLE "batches" DROP COLUMN IF EXISTS "recipe_ingredients";
