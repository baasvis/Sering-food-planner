-- Sering Hub Phase 3 (plan §3.1-§3.5): source-scoped daily L2 tables + the
-- L1 tables for timeclock, foodcost, catering, manual line items and the
-- Lightspeed historical importer. Hub-only tables per the §1.10
-- schema-authority discipline; additive apart from the daily-L2 unique-index
-- rebuilds below (those tables are empty on prod until the Hub's Phase 2
-- deploys, and tiny on staging).

-- ── source column on the daily L2 tables ──
-- 'tebi' | 'lightspeed'. Each upstream's recompute deletes only its own
-- source's rows, so the TestTafel Lightspeed era (pre ~2026-05) and the Tebi
-- era can coexist without clobbering each other.

ALTER TABLE "sales_5min_bucket" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'tebi';
DROP INDEX "sales_5min_bucket_org_date_hour_minute_key";
CREATE UNIQUE INDEX "sales_5min_bucket_source_org_date_hour_minute_key"
    ON "sales_5min_bucket"("source", "org", "date", "hour_minute");

ALTER TABLE "sales_hour" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'tebi';
DROP INDEX "sales_hour_org_date_hour_key";
CREATE UNIQUE INDEX "sales_hour_source_org_date_hour_key"
    ON "sales_hour"("source", "org", "date", "hour");

ALTER TABLE "sales_day" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'tebi';
DROP INDEX "sales_day_org_date_key";
CREATE UNIQUE INDEX "sales_day_source_org_date_key"
    ON "sales_day"("source", "org", "date");

ALTER TABLE "product_day" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'tebi';
DROP INDEX "product_day_org_date_product_name_key";
CREATE UNIQUE INDEX "product_day_source_org_date_product_name_key"
    ON "product_day"("source", "org", "date", "product_name");

ALTER TABLE "type_day" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'tebi';
DROP INDEX "type_day_org_date_type_regtype_key";
CREATE UNIQUE INDEX "type_day_source_org_date_type_regtype_key"
    ON "type_day"("source", "org", "date", "type", "regtype");

-- ── L1: timeclock ──

CREATE TABLE "timeclock_entry" (
    "id" SERIAL NOT NULL,
    "person" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "source_file" TEXT NOT NULL DEFAULT '',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timeclock_entry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "timeclock_entry_person_start_job_type_key"
    ON "timeclock_entry"("person", "start", "job_type");
CREATE INDEX "timeclock_entry_start_idx" ON "timeclock_entry"("start");

CREATE TABLE "hours_adjustment" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "hours" DECIMAL(10,2),
    "hourly_rate" DECIMAL(10,2),
    "total" DECIMAL(10,2) NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hours_adjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hours_adjustment_year_week_idx" ON "hours_adjustment"("year", "week");

-- ── L1: foodcost ──

CREATE TABLE "foodcost_invoice" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "gross" DECIMAL(10,2) NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "client_number" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "foodcost_invoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "foodcost_invoice_year_week_idx" ON "foodcost_invoice"("year", "week");

-- ── L1: catering ──

CREATE TABLE "catering_invoice" (
    "id" SERIAL NOT NULL,
    "factuur_number" TEXT NOT NULL DEFAULT '',
    "event_date" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catering_invoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catering_invoice_event_date_idx" ON "catering_invoice"("event_date");

CREATE TABLE "catering_invoice_line_item" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "org" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "gross" DECIMAL(10,2) NOT NULL,
    "count" INTEGER,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "catering_invoice_line_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catering_invoice_line_item_invoice_id_idx"
    ON "catering_invoice_line_item"("invoice_id");

ALTER TABLE "catering_invoice_line_item"
    ADD CONSTRAINT "catering_invoice_line_item_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "catering_invoice"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── L1: manual line items ──

CREATE TABLE "manual_line_item" (
    "id" SERIAL NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_line_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "manual_line_item_org_year_week_label_key"
    ON "manual_line_item"("org", "year", "week", "label");
CREATE INDEX "manual_line_item_year_week_idx" ON "manual_line_item"("year", "week");

-- ── L1: Lightspeed historical exports ──

CREATE TABLE "lightspeed_receipt" (
    "id" SERIAL NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "sequence_number" TEXT NOT NULL DEFAULT '',
    "creation_date" TIMESTAMP(3) NOT NULL,
    "finalized_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT '',
    "table_name" TEXT NOT NULL DEFAULT '',
    "net_total" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "tip" DECIMAL(10,2) NOT NULL,
    "taxes" TEXT NOT NULL DEFAULT '',
    "covers" INTEGER NOT NULL DEFAULT 0,
    "source_file" TEXT NOT NULL DEFAULT '',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lightspeed_receipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lightspeed_receipt_receipt_id_key" ON "lightspeed_receipt"("receipt_id");
CREATE INDEX "lightspeed_receipt_creation_date_idx" ON "lightspeed_receipt"("creation_date");

CREATE TABLE "lightspeed_receipt_item" (
    "id" SERIAL NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gross" DECIMAL(10,2) NOT NULL,
    "tax_percentage" DECIMAL(5,2) NOT NULL,
    "creation_date" TIMESTAMP(3) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lightspeed_receipt_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lightspeed_receipt_item_receipt_id_idx" ON "lightspeed_receipt_item"("receipt_id");
CREATE INDEX "lightspeed_receipt_item_creation_date_idx" ON "lightspeed_receipt_item"("creation_date");

CREATE TABLE "lightspeed_payment" (
    "id" SERIAL NOT NULL,
    "payment_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT '',
    "payment_type" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(10,2) NOT NULL,
    "tip" DECIMAL(10,2) NOT NULL,
    "created_date" TIMESTAMP(3) NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lightspeed_payment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lightspeed_payment_payment_id_key" ON "lightspeed_payment"("payment_id");
CREATE INDEX "lightspeed_payment_receipt_id_idx" ON "lightspeed_payment"("receipt_id");
