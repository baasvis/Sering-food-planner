-- Sering Hub Phase 2 (plan §2.1): L1 TebiProductDaily + the L2 layer tables.
-- Written and read by the Hub only; they live in the planner-owned schema per
-- the §1.10 schema-authority discipline (planner runs migrate deploy, Hub
-- copies the schema and runs prisma generate only). Additive — no existing
-- table is touched.

-- L1: raw per-day per-profit-center product_top rows (pre-misattribution).
CREATE TABLE "tebi_product_daily" (
    "id" SERIAL NOT NULL,
    "ledger" TEXT NOT NULL,
    "profit_center_id" TEXT NOT NULL,
    "profit_center_name" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gross_revenue" DECIMAL(10,2) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tebi_product_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tebi_product_daily_ledger_profit_center_id_date_product_na_key"
    ON "tebi_product_daily"("ledger", "profit_center_id", "date", "product_name");
CREATE INDEX "tebi_product_daily_date_idx" ON "tebi_product_daily"("date");
CREATE INDEX "tebi_product_daily_profit_center_name_date_idx"
    ON "tebi_product_daily"("profit_center_name", "date");

-- L2: 5-minute sales buckets from TebiInvoice timestamps.
CREATE TABLE "sales_5min_bucket" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "hour_minute" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "gross" DECIMAL(10,2) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_5min_bucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_5min_bucket_org_date_hour_minute_key"
    ON "sales_5min_bucket"("org", "date", "hour_minute");
CREATE INDEX "sales_5min_bucket_date_idx" ON "sales_5min_bucket"("date");

-- L2: hourly sales from TebiInvoice.
CREATE TABLE "sales_hour" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "hour" INTEGER NOT NULL,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "gross" DECIMAL(10,2) NOT NULL,
    "net" DECIMAL(10,2) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_hour_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_hour_org_date_hour_key" ON "sales_hour"("org", "date", "hour");
CREATE INDEX "sales_hour_date_idx" ON "sales_hour"("date");

-- L2: per-day per-org totals.
CREATE TABLE "sales_day" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "gross" DECIMAL(10,2) NOT NULL,
    "net" DECIMAL(10,2) NOT NULL,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "covers" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_day_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_day_org_date_key" ON "sales_day"("org", "date");
CREATE INDEX "sales_day_date_idx" ON "sales_day"("date");

-- L2: per-day per-org per-product rows (misattribution applied, typed).
CREATE TABLE "product_day" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "type" TEXT,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gross" DECIMAL(10,2) NOT NULL,
    "net" DECIMAL(10,2) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_day_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_day_org_date_product_name_key"
    ON "product_day"("org", "date", "product_name");
CREATE INDEX "product_day_date_idx" ON "product_day"("date");
CREATE INDEX "product_day_org_type_date_idx" ON "product_day"("org", "type", "date");

-- L2: per-day per-Type aggregates.
CREATE TABLE "type_day" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "regtype" TEXT NOT NULL DEFAULT 'REGULAR',
    "count" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gross" DECIMAL(10,2) NOT NULL,
    "net" DECIMAL(10,2) NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "type_day_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "type_day_org_date_type_regtype_key"
    ON "type_day"("org", "date", "type", "regtype");
CREATE INDEX "type_day_date_idx" ON "type_day"("date");

-- L2: ISO-week per-Type revenue (xlsx "Revenue input" equivalent).
CREATE TABLE "weekly_revenue" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "regtype" TEXT NOT NULL DEFAULT 'REGULAR',
    "count" DOUBLE PRECISION,
    "gross" DECIMAL(10,2) NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_revenue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_revenue_org_year_week_type_regtype_key"
    ON "weekly_revenue"("org", "year", "week", "type", "regtype");
CREATE INDEX "weekly_revenue_year_week_idx" ON "weekly_revenue"("year", "week");

-- L2: ISO-week guest counts (exclusive lunch/dinner/staff).
CREATE TABLE "weekly_guests" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "meal" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_guests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_guests_org_year_week_meal_key"
    ON "weekly_guests"("org", "year", "week", "meal");
CREATE INDEX "weekly_guests_year_week_idx" ON "weekly_guests"("year", "week");

-- L2 (Hub Phase 3 fills these; schema lands now so the planner deploys once).
CREATE TABLE "weekly_hours" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "hours" DECIMAL(10,2) NOT NULL,
    "hourly_rate" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_hours_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_hours_org_year_week_role_key"
    ON "weekly_hours"("org", "year", "week", "role");
CREATE INDEX "weekly_hours_year_week_idx" ON "weekly_hours"("year", "week");

CREATE TABLE "weekly_foodcost" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "gross" DECIMAL(10,2) NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_foodcost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_foodcost_org_year_week_source_key"
    ON "weekly_foodcost"("org", "year", "week", "source");
CREATE INDEX "weekly_foodcost_year_week_idx" ON "weekly_foodcost"("year", "week");

CREATE TABLE "weekly_line_item" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_line_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "weekly_line_item_org_year_week_label_key"
    ON "weekly_line_item"("org", "year", "week", "label");
CREATE INDEX "weekly_line_item_year_week_idx" ON "weekly_line_item"("year", "week");
