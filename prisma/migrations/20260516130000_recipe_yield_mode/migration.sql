-- Recipe yield mode: volume-scaled (soups/mains, by liters) vs count-scaled
-- (toppings & bread, by discrete output count — "makes 10 loaves").
-- All additive + nullable; existing recipes default to volume mode at runtime.
ALTER TABLE "recipes" ADD COLUMN "yield_type" TEXT;
ALTER TABLE "recipes" ADD COLUMN "output_count" DOUBLE PRECISION;
ALTER TABLE "recipes" ADD COLUMN "output_unit" TEXT;
