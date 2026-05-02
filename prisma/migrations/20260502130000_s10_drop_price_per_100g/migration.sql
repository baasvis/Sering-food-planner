-- S10: drop the redundant Ingredient.pricePer100g column
--
-- Two columns held the same logical value:
--   - price_per_100   ← the only column written by current routes/ingredients.ts
--   - price_per_100g  ← legacy from the March 2026 import; read everywhere as
--                       `pricePer100g || pricePer100 || 0`, never written by
--                       any current code path
--
-- Result: ingredients seeded with both got the right cost, ingredients
-- created or saved AFTER the migration silently lost their cost (because
-- pricePer100g defaulted to 0 and the read-with-fallback prefers it).
-- See audit-2026-05-01.md §1.2 for the silent-bug write-up.
--
-- This migration:
--   1. Backfills price_per_100 from price_per_100g where price_per_100 is
--      missing/zero so existing data is preserved.
--   2. Drops price_per_100g.
--
-- Reads are updated in the same commit to use price_per_100 directly.

-- Backfill: prefer the existing price_per_100, fall back to price_per_100g
-- only when price_per_100 is zero. NULLIF returns NULL when the value is 0,
-- and COALESCE then picks the next non-NULL.
UPDATE "ingredients"
   SET "price_per_100" = COALESCE(NULLIF("price_per_100", 0), "price_per_100g")
 WHERE "price_per_100" = 0
   AND "price_per_100g" > 0;

-- Drop the redundant column.
ALTER TABLE "ingredients" DROP COLUMN "price_per_100g";
