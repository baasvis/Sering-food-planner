-- Match the @default([]) added to Chunk.locations / prerequisites / requiredFor.
-- ALTER COLUMN SET DEFAULT is metadata-only: no table rewrite, existing rows
-- untouched. It only fixes the default for future inserts that omit the column.
ALTER TABLE "chunks" ALTER COLUMN "locations" SET DEFAULT ARRAY[]::text[];
ALTER TABLE "chunks" ALTER COLUMN "prerequisites" SET DEFAULT ARRAY[]::text[];
ALTER TABLE "chunks" ALTER COLUMN "required_for" SET DEFAULT ARRAY[]::text[];
