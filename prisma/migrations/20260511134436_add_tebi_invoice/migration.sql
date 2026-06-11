-- CreateTable
CREATE TABLE "tebi_invoice" (
    "id" SERIAL NOT NULL,
    "ledger" TEXT NOT NULL,
    "profit_center_id" TEXT,
    "profit_center_name" TEXT,
    "invoice_key" TEXT NOT NULL,
    "sequence_number" TEXT,
    "name" TEXT,
    "business_day" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "closed_time" TIMESTAMP(3),
    "gross_revenue" DECIMAL(10,2) NOT NULL,
    "net_revenue" DECIMAL(10,2) NOT NULL,
    "guest" INTEGER,
    "receipt_url" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tebi_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tebi_invoice_business_day_idx" ON "tebi_invoice"("business_day");

-- CreateIndex
CREATE INDEX "tebi_invoice_profit_center_name_business_day_idx" ON "tebi_invoice"("profit_center_name", "business_day");

-- CreateIndex
CREATE UNIQUE INDEX "tebi_invoice_ledger_invoice_key_key" ON "tebi_invoice"("ledger", "invoice_key");
