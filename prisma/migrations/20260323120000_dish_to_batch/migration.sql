-- Migrate Dish + Service tables → single Batch table
-- Maps: logistics → location, embeds services as JSON, drops removed fields

-- 1. Create batches table
CREATE TABLE "batches" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "serving" INTEGER NOT NULL DEFAULT 280,
    "storage" TEXT NOT NULL DEFAULT 'Gastro',
    "location" TEXT NOT NULL DEFAULT 'west',
    "in_transit" BOOLEAN NOT NULL DEFAULT false,
    "allergens" TEXT[],
    "extra_allergens" TEXT[],
    "order_for" BOOLEAN NOT NULL DEFAULT false,
    "cook_date" TEXT,
    "recipe_sheet_id" TEXT,
    "recipe_volume" DOUBLE PRECISION,
    "recipe_ingredients" JSONB,
    "parent_id" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "services" JSONB NOT NULL DEFAULT '[]',
    "created_at" TEXT NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- 2. Migrate data from dishes → batches, mapping logistics → location
INSERT INTO "batches" (
    "id", "name", "type", "stock", "serving", "storage",
    "location", "in_transit",
    "allergens", "extra_allergens", "order_for",
    "cook_date", "recipe_sheet_id", "recipe_volume", "recipe_ingredients",
    "parent_id", "note", "services", "created_at"
)
SELECT
    d."id", d."name", d."type", d."stock", d."serving", d."storage",
    -- Map logistics to location
    CASE
        WHEN d."logistics" IN ('Sering West', 'Transport to Sering Centraal') THEN 'west'
        WHEN d."logistics" IN ('Sering Centraal', 'Transport to Sering West') THEN 'centraal'
        ELSE 'west'
    END AS "location",
    -- Map transport logistics to inTransit
    CASE
        WHEN d."logistics" IN ('Transport to Sering Centraal', 'Transport to Sering West') THEN true
        ELSE false
    END AS "in_transit",
    d."allergens", d."extra_allergens", d."order_for",
    d."cook_date", d."recipe_sheet_id", d."recipe_volume", d."recipe_ingredients",
    d."parent_id",
    '' AS "note",
    -- Embed services as JSON array
    COALESCE(
        (SELECT jsonb_agg(jsonb_build_object('loc', s."location", 'date', s."date", 'meal', s."meal"))
         FROM "services" s WHERE s."dish_id" = d."id"),
        '[]'::jsonb
    ) AS "services",
    d."created_at"
FROM "dishes" d;

-- 3. Drop old tables (services first due to FK)
DROP TABLE "services";
DROP TABLE "dishes";
