-- Task A of unified-batch-inventory rewrite: add the new JSONB columns
-- additively. Old columns (stock, storage, location, in_transit, parent_id,
-- recipe_sheet_id, recipe_volume, recipe_ingredients) are intentionally
-- preserved in this migration so the Task B data-migrate script can read
-- from them. They will be dropped in the follow-up migration.
--
-- IF NOT EXISTS guards make this safe to re-apply against staging or prod
-- if a partial run occurred — matches the pattern from
-- 20260415120000_add_ingredient_drifted_columns.

ALTER TABLE "batches"
  ADD COLUMN IF NOT EXISTS "inventory" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "batches"
  ADD COLUMN IF NOT EXISTS "shipments" JSONB NOT NULL DEFAULT '[]'::jsonb;
