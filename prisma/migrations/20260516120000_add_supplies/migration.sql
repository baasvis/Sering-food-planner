-- Add toppings column to caterings (referenced by Supply rows for catering-driven prep)
ALTER TABLE "caterings" ADD COLUMN "toppings" JSONB NOT NULL DEFAULT '[]';

-- CreateTable: supplies
CREATE TABLE "supplies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "recipe_id" TEXT,
    "guests_per_unit" DOUBLE PRECISION,
    "prep_horizon_days" INTEGER,
    "prep_mode" TEXT,
    "oneoff_location" TEXT,
    "units_per_service" DOUBLE PRECISION,
    "oneoff_start_date" TEXT,
    "stock" JSONB NOT NULL DEFAULT '{}',
    "cost_per_unit" DOUBLE PRECISION,
    "preservation_method" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplies_archived_idx" ON "supplies"("archived");
CREATE INDEX "supplies_kind_idx" ON "supplies"("kind");

-- AddForeignKey
ALTER TABLE "supplies" ADD CONSTRAINT "supplies_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
