-- Event locations: temporary festival/catering sites (e.g. Landjuweel 2026).
-- The id is the location slug ("ev-<name>") referenced as a plain string by
-- batch services/inventory/shipments, guest rows, supply stock JSON, standard
-- inventory, prep checklists — immutable, never reused, survives archive.

-- CreateTable
CREATE TABLE "event_locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "hanos_account" TEXT NOT NULL DEFAULT 'west',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "event_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_locations_archived_idx" ON "event_locations"("archived");
