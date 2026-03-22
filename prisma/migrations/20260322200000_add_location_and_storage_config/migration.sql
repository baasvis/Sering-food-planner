-- Add location column to standard_inventory
ALTER TABLE "standard_inventory" ADD COLUMN "location" TEXT NOT NULL DEFAULT 'west';

-- Create storage_config table
CREATE TABLE "storage_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "storage_config_pkey" PRIMARY KEY ("id")
);
