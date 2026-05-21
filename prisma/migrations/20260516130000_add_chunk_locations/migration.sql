-- AlterTable
ALTER TABLE "chunks" ADD COLUMN "locations" TEXT[];

-- Backfill existing rows to an empty array so no row carries a NULL list.
UPDATE "chunks" SET "locations" = '{}' WHERE "locations" IS NULL;
