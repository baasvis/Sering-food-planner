-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "dishes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "serving" INTEGER NOT NULL DEFAULT 280,
    "storage" TEXT NOT NULL DEFAULT 'Gastro',
    "logistics" TEXT NOT NULL DEFAULT 'Sering West',
    "allergens" TEXT[],
    "extra_allergens" TEXT[],
    "order_for" BOOLEAN NOT NULL DEFAULT false,
    "cook_mode" TEXT NOT NULL DEFAULT 'day',
    "cook_day" TEXT,
    "cook_date" TEXT,
    "cook_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "recipe_sheet_id" TEXT,
    "recipe_volume" DOUBLE PRECISION,
    "recipe_ingredients" JSONB,
    "parent_id" TEXT,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "dishes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "dish_id" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "meal" TEXT NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" SERIAL NOT NULL,
    "location" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "lunch" INTEGER NOT NULL DEFAULT 0,
    "dinner" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_index" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'Soup',
    "recipe_sheet_id" TEXT,
    "allergens" TEXT[],
    "cost_per_serving" TEXT NOT NULL DEFAULT '',
    "structure" TEXT NOT NULL DEFAULT '',
    "seasonality" TEXT NOT NULL DEFAULT '',
    "serving_temp" TEXT NOT NULL DEFAULT '',
    "serving_size" INTEGER NOT NULL DEFAULT 280,
    "recipe_volume" DOUBLE PRECISION,
    "recipe_ingredients" JSONB,
    "created_at" TEXT NOT NULL,
    "avg_skill" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_speed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_banger" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "times_served" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "recipe_index_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caterings" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "date" TEXT,
    "guest_count" INTEGER NOT NULL DEFAULT 0,
    "delivery_mode" TEXT NOT NULL DEFAULT 'pickup',
    "dishes" JSONB NOT NULL DEFAULT '[]',
    "logistics_notes" TEXT NOT NULL DEFAULT '',
    "created_at" TEXT NOT NULL,

    CONSTRAINT "caterings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_items" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "transport_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "supplier_name" TEXT NOT NULL DEFAULT '',
    "types" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT 'Grams',
    "supplier" TEXT NOT NULL DEFAULT '',
    "order_code" TEXT NOT NULL DEFAULT '',
    "order_unit" TEXT NOT NULL DEFAULT '',
    "order_unit_standard" TEXT NOT NULL DEFAULT '',
    "order_price" DOUBLE PRECISION,
    "order_amount_grams" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "price_level" TEXT NOT NULL DEFAULT '',
    "price_per_100g" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "price_history" JSONB NOT NULL DEFAULT '[]',
    "price_alert" BOOLEAN NOT NULL DEFAULT false,
    "storage_locations" JSONB NOT NULL DEFAULT '{}',
    "stock" JSONB NOT NULL DEFAULT '{}',
    "nutrition" JSONB NOT NULL DEFAULT '{}',
    "allergens" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_history" (
    "id" SERIAL NOT NULL,
    "location" TEXT NOT NULL,
    "meal" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "guest_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_history_meta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "guest_history_meta_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "guests_next_weeks" (
    "id" SERIAL NOT NULL,
    "monday_key" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "meal" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "guests_next_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "log" (
    "id" SERIAL NOT NULL,
    "timestamp" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL,

    CONSTRAINT "log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" SERIAL NOT NULL,
    "timestamp" TEXT NOT NULL,
    "user" TEXT NOT NULL DEFAULT 'anonymous',
    "type" TEXT NOT NULL DEFAULT 'general',
    "screen" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standard_inventory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "standard_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prep_checklist" (
    "id" SERIAL NOT NULL,
    "loc" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "checked" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prep_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guests_location_day_key" ON "guests"("location", "day");

-- CreateIndex
CREATE UNIQUE INDEX "guest_history_location_meal_date_key" ON "guest_history"("location", "meal", "date");

-- CreateIndex
CREATE UNIQUE INDEX "guests_next_weeks_monday_key_location_day_meal_key" ON "guests_next_weeks"("monday_key", "location", "day", "meal");

-- CreateIndex
CREATE UNIQUE INDEX "prep_checklist_loc_date_key" ON "prep_checklist"("loc", "date");

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_dish_id_fkey" FOREIGN KEY ("dish_id") REFERENCES "dishes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

