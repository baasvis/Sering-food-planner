-- CreateTable
CREATE TABLE "recipes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'Soup',
    "structure" TEXT NOT NULL DEFAULT '',
    "seasonality" TEXT NOT NULL DEFAULT '',
    "serving_temp" TEXT NOT NULL DEFAULT '',
    "serving_size" INTEGER NOT NULL DEFAULT 280,
    "recipe_volume" DOUBLE PRECISION,
    "auto_allergens" TEXT[],
    "extra_allergens" TEXT[],
    "cost_per_serving" DOUBLE PRECISION,
    "avg_skill" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_speed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_banger" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "times_served" INTEGER NOT NULL DEFAULT 0,
    "prep_steps" JSONB NOT NULL DEFAULT '[]',
    "cooling_method" TEXT NOT NULL DEFAULT '',
    "storage_method" TEXT NOT NULL DEFAULT '',
    "photo_url" TEXT,
    "is_complete" BOOLEAN NOT NULL DEFAULT false,
    "versions" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT NOT NULL DEFAULT '',
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "legacy_sheet_id" TEXT,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredients" (
    "id" TEXT NOT NULL,
    "recipe_id" TEXT NOT NULL,
    "ingredient_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "raw_amount" DOUBLE PRECISION NOT NULL,
    "cooked_amount" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT 'Grams',
    "is_flexible" BOOLEAN NOT NULL DEFAULT false,
    "flex_category" TEXT,
    "flex_label" TEXT,
    "suggested_names" TEXT[],

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_photos" (
    "id" TEXT NOT NULL,
    "recipe_id" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "recipe_photos_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Add recipe v2 fields to batches
ALTER TABLE "batches" ADD COLUMN "recipe_id" TEXT;
ALTER TABLE "batches" ADD COLUMN "actual_ingredients" JSONB;
ALTER TABLE "batches" ADD COLUMN "cook_notes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "batches" ADD COLUMN "stock_deducted" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "recipes_type_idx" ON "recipes"("type");

-- CreateIndex
CREATE INDEX "recipe_ingredients_recipe_id_idx" ON "recipe_ingredients"("recipe_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_photos_recipe_id_key" ON "recipe_photos"("recipe_id");

-- CreateIndex
CREATE INDEX "batches_recipe_id_idx" ON "batches"("recipe_id");

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
