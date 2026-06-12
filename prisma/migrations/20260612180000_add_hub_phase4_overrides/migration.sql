-- Hub Phase 4 (plan §4.4-§4.6): overrides, computed cells, recurring line
-- items. Hub-only tables per the §1.10 schema-authority discipline. Additive.

-- Per-cell correction with structured (typed, indexable) key columns.
CREATE TABLE "override" (
    "id" SERIAL NOT NULL,
    "table_name" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "week" INTEGER,
    "date" TEXT,
    "role" TEXT,
    "source" TEXT,
    "type" TEXT,
    "regtype" TEXT,
    "label" TEXT,
    "product_name" TEXT,
    "field" TEXT NOT NULL,
    "value_number" DECIMAL(15,4),
    "value_string" TEXT,
    "value_date" TIMESTAMP(3),
    "author" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "revoke_reason" TEXT,

    CONSTRAINT "override_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "override_table_name_org_year_week_idx"
    ON "override"("table_name", "org", "year", "week");

-- Formula-driven cell.
CREATE TABLE "computed_cell" (
    "id" SERIAL NOT NULL,
    "table_name" TEXT NOT NULL DEFAULT 'WeeklyLineItem',
    "org" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "field" TEXT NOT NULL DEFAULT 'amount',
    "start_year" INTEGER NOT NULL,
    "start_week" INTEGER NOT NULL,
    "end_year" INTEGER,
    "end_week" INTEGER,
    "formula" TEXT NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "author" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computed_cell_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "computed_cell_org_start_year_start_week_idx"
    ON "computed_cell"("org", "start_year", "start_week");

-- Recurring cost (org null = sering-wide, split by revenue share).
CREATE TABLE "recurring_line_item" (
    "id" SERIAL NOT NULL,
    "org" TEXT,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "btw_rate" DECIMAL(5,4) NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'weekly',
    "start_year" INTEGER NOT NULL,
    "start_week" INTEGER NOT NULL,
    "end_year" INTEGER,
    "end_week" INTEGER,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_line_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recurring_line_item_start_year_start_week_idx"
    ON "recurring_line_item"("start_year", "start_week");
