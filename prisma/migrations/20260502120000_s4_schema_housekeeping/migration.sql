-- S4: schema housekeeping
--   - Drop dead columns Ingredient.orderUnitStandard / orderAmountGrams (zero
--     references in any current routes/lib/public; only ever written by the
--     one-shot scripts/migrate-ingredients.js from March 2026).
--   - Add FK indexes that Postgres does NOT auto-create:
--       batches.parent_id
--       recipe_ingredients.ingredient_id
--       guests_next_weeks.monday_key
--   - Add the missing FK + ON DELETE CASCADE between recipe_photos.recipe_id
--     and recipes.id. Prior schema had recipe_id @unique but no relation
--     declared — orphan photos were possible if any path skipped the
--     manual cleanup in routes/recipes.ts.

-- Drop dead columns from ingredients
ALTER TABLE "ingredients" DROP COLUMN "order_amount_grams";
ALTER TABLE "ingredients" DROP COLUMN "order_unit_standard";

-- FK indexes (Postgres doesn't index FKs automatically)
CREATE INDEX "batches_parent_id_idx" ON "batches"("parent_id");
CREATE INDEX "recipe_ingredients_ingredient_id_idx" ON "recipe_ingredients"("ingredient_id");
CREATE INDEX "guests_next_weeks_monday_key_idx" ON "guests_next_weeks"("monday_key");

-- recipe_photos → recipes FK with cascade-on-delete
ALTER TABLE "recipe_photos"
  ADD CONSTRAINT "recipe_photos_recipe_id_fkey"
  FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
