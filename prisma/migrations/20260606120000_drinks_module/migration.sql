-- Drinks module — additive only (new tables/indexes/foreign keys).
--
-- NOTE: `prisma migrate diff` against the staging DB also emitted statements to
-- drop the legacy unified-batch columns (location/stock/parent_id/…) and the old
-- `tebi_invoice` table. That is PRE-EXISTING drift — the manual `drop-cols` psql
-- step (kept outside Prisma's migration loader, see prisma/migrations/DEPLOY.md)
-- was applied to prod but not to this staging DB. Those drops are unrelated to
-- the drinks module and out of scope for this run, so they are intentionally
-- omitted here. This migration only CREATEs new drinks tables.

-- CreateTable
CREATE TABLE "drinks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subtype" TEXT NOT NULL DEFAULT '',
    "abv" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "btw_rate" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "sellable" BOOLEAN NOT NULL DEFAULT true,
    "supplier" TEXT NOT NULL DEFAULT '',
    "order_unit" TEXT NOT NULL DEFAULT '',
    "order_unit_ml" DOUBLE PRECISION,
    "pack_note" TEXT NOT NULL DEFAULT '',
    "item_id" TEXT,
    "deposit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost_price" DOUBLE PRECISION,
    "cost_note" TEXT NOT NULL DEFAULT '',
    "formats" JSONB NOT NULL DEFAULT '[]',
    "locations" JSONB NOT NULL DEFAULT '{}',
    "info" JSONB NOT NULL DEFAULT '{}',
    "tebi_product_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serve_volume_ml" DOUBLE PRECISION,
    "glass" TEXT NOT NULL DEFAULT '',
    "glass_volume_ml" DOUBLE PRECISION,
    "serving_temp" TEXT NOT NULL DEFAULT '',
    "characteristics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "garnish" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seasonality" TEXT NOT NULL DEFAULT '',
    "service_instructions" TEXT NOT NULL DEFAULT '',
    "prep_steps" JSONB NOT NULL DEFAULT '[]',
    "batch" JSONB NOT NULL DEFAULT '{}',
    "prep_time" JSONB NOT NULL DEFAULT '{}',
    "shelf_life_days" INTEGER,
    "cost_per_serve" DOUBLE PRECISION,
    "suggested_price" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drinks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_ingredient_rows" (
    "id" TEXT NOT NULL,
    "drink_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "ref_kind" TEXT NOT NULL,
    "ingredient_id" TEXT,
    "ref_drink_id" TEXT,
    "amount" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT 'ml',
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "drink_ingredient_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "products" TEXT NOT NULL DEFAULT '',
    "order_days" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "order_days_note" TEXT NOT NULL DEFAULT '',
    "order_cutoff" TEXT NOT NULL DEFAULT '',
    "delivery_window" TEXT NOT NULL DEFAULT '',
    "contact" JSONB NOT NULL DEFAULT '{}',
    "minimum_order" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "price_list_ref" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drink_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_stock" (
    "id" TEXT NOT NULL,
    "drink_id" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "area" TEXT NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "counted_by" TEXT NOT NULL DEFAULT '',
    "counted_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drink_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_orders" (
    "id" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "supplier" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "ordered_by" TEXT,
    "ordered_at" TIMESTAMP(3),
    "expected_delivery" TEXT,
    "received_by" TEXT,
    "received_at" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drink_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_order_lines" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "drink_id" TEXT,
    "ingredient_id" TEXT,
    "name" TEXT NOT NULL DEFAULT '',
    "ordered_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "order_unit" TEXT NOT NULL DEFAULT '',
    "received_qty" DOUBLE PRECISION,
    "substituted_by" TEXT,
    "deposit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "drink_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_production_logs" (
    "id" TEXT NOT NULL,
    "drink_id" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "batches_made" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "volume_ml" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bottles_yielded" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "made_by" TEXT NOT NULL DEFAULT '',
    "made_on" TEXT NOT NULL,
    "expires_on" TEXT,
    "status" TEXT NOT NULL DEFAULT 'fresh',
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drink_production_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_write_offs" (
    "id" TEXT NOT NULL,
    "ref_kind" TEXT NOT NULL,
    "drink_id" TEXT,
    "ingredient_id" TEXT,
    "name" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "who" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drink_write_offs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assortments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "service_context" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "entries" JSONB NOT NULL DEFAULT '[]',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assortments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_menus" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assortment_id" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "sections" JSONB NOT NULL DEFAULT '[]',
    "layout" JSONB NOT NULL DEFAULT '{}',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drink_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drink_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "drink_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "drinks_mode_idx" ON "drinks"("mode");

-- CreateIndex
CREATE INDEX "drinks_category_idx" ON "drinks"("category");

-- CreateIndex
CREATE INDEX "drinks_status_idx" ON "drinks"("status");

-- CreateIndex
CREATE INDEX "drinks_archived_idx" ON "drinks"("archived");

-- CreateIndex
CREATE INDEX "drink_ingredient_rows_drink_id_idx" ON "drink_ingredient_rows"("drink_id");

-- CreateIndex
CREATE INDEX "drink_ingredient_rows_ingredient_id_idx" ON "drink_ingredient_rows"("ingredient_id");

-- CreateIndex
CREATE INDEX "drink_ingredient_rows_ref_drink_id_idx" ON "drink_ingredient_rows"("ref_drink_id");

-- CreateIndex
CREATE UNIQUE INDEX "drink_suppliers_name_key" ON "drink_suppliers"("name");

-- CreateIndex
CREATE INDEX "drink_stock_drink_id_idx" ON "drink_stock"("drink_id");

-- CreateIndex
CREATE INDEX "drink_stock_location_idx" ON "drink_stock"("location");

-- CreateIndex
CREATE UNIQUE INDEX "drink_stock_drink_id_location_area_key" ON "drink_stock"("drink_id", "location", "area");

-- CreateIndex
CREATE INDEX "drink_orders_location_idx" ON "drink_orders"("location");

-- CreateIndex
CREATE INDEX "drink_orders_status_idx" ON "drink_orders"("status");

-- CreateIndex
CREATE INDEX "drink_order_lines_order_id_idx" ON "drink_order_lines"("order_id");

-- CreateIndex
CREATE INDEX "drink_production_logs_drink_id_idx" ON "drink_production_logs"("drink_id");

-- CreateIndex
CREATE INDEX "drink_production_logs_location_idx" ON "drink_production_logs"("location");

-- CreateIndex
CREATE INDEX "drink_write_offs_ref_kind_idx" ON "drink_write_offs"("ref_kind");

-- CreateIndex
CREATE INDEX "drink_write_offs_location_idx" ON "drink_write_offs"("location");

-- CreateIndex
CREATE INDEX "assortments_location_idx" ON "assortments"("location");

-- CreateIndex
CREATE INDEX "drink_menus_assortment_id_idx" ON "drink_menus"("assortment_id");

-- AddForeignKey
ALTER TABLE "drink_ingredient_rows" ADD CONSTRAINT "drink_ingredient_rows_drink_id_fkey" FOREIGN KEY ("drink_id") REFERENCES "drinks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drink_ingredient_rows" ADD CONSTRAINT "drink_ingredient_rows_ref_drink_id_fkey" FOREIGN KEY ("ref_drink_id") REFERENCES "drinks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drink_stock" ADD CONSTRAINT "drink_stock_drink_id_fkey" FOREIGN KEY ("drink_id") REFERENCES "drinks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drink_order_lines" ADD CONSTRAINT "drink_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "drink_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drink_production_logs" ADD CONSTRAINT "drink_production_logs_drink_id_fkey" FOREIGN KEY ("drink_id") REFERENCES "drinks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drink_menus" ADD CONSTRAINT "drink_menus_assortment_id_fkey" FOREIGN KEY ("assortment_id") REFERENCES "assortments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
