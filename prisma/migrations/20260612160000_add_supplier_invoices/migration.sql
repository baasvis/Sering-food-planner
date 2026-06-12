-- Hub: SupplierInvoice + line items — L1 capture for ALL parsed supplier
-- invoices (food, drinks, overhead; the cowork invoice-pass writes these).
-- Hub-only tables per the §1.10 schema-authority discipline. Additive.

CREATE TABLE "supplier_invoice" (
    "id" SERIAL NOT NULL,
    "vendor" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "invoice_date" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "total_incl" DECIMAL(10,2) NOT NULL,
    "total_excl" DECIMAL(10,2),
    "btw_low_base" DECIMAL(10,2),
    "btw_high_base" DECIMAL(10,2),
    "category" TEXT NOT NULL DEFAULT 'food',
    "category_totals" JSONB NOT NULL DEFAULT '{}',
    "drive_file_id" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_invoice_vendor_invoice_number_key"
    ON "supplier_invoice"("vendor", "invoice_number");
CREATE INDEX "supplier_invoice_year_week_idx" ON "supplier_invoice"("year", "week");
CREATE INDEX "supplier_invoice_org_year_week_idx" ON "supplier_invoice"("org", "year", "week");

CREATE TABLE "supplier_invoice_line_item" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "article_number" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT '',
    "unit_price" DECIMAL(10,4),
    "amount" DECIMAL(10,2) NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "delivery_date" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "supplier_invoice_line_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "supplier_invoice_line_item_invoice_id_idx"
    ON "supplier_invoice_line_item"("invoice_id");
CREATE INDEX "supplier_invoice_line_item_article_number_idx"
    ON "supplier_invoice_line_item"("article_number");

ALTER TABLE "supplier_invoice_line_item"
    ADD CONSTRAINT "supplier_invoice_line_item_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoice"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
