-- Captures the DailyRevenue and ProductRevenue models that were previously
-- added to schema.prisma and pushed directly to production via `prisma db push`,
-- without an accompanying migration file. This migration backfills that history.
--
-- On existing environments (production, staging) it is marked as already applied
-- via `prisma migrate resolve --applied 20260415130000_add_revenue_tables`.
-- On fresh environments it runs normally.

-- CreateTable
CREATE TABLE "daily_revenue" (
    "id" SERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "gross_revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net_revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "covers" INTEGER NOT NULL DEFAULT 0,
    "invoice_count" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TEXT NOT NULL,

    CONSTRAINT "daily_revenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_revenue" (
    "id" SERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "meal" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "product_category" TEXT NOT NULL DEFAULT '',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gross_revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net_revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "synced_at" TEXT NOT NULL,

    CONSTRAINT "product_revenue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_revenue_date_location_key" ON "daily_revenue"("date", "location");

-- CreateIndex
CREATE UNIQUE INDEX "product_revenue_date_location_meal_product_name_key" ON "product_revenue"("date", "location", "meal", "product_name");
