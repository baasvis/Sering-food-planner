-- Drink final-product photos. Mirrors recipe_photos: the image bytes live in the
-- DB and are served via GET /api/drinks/:id/photo; drinks.photo_url holds that URL
-- when a photo exists. Additive only (new nullable column + new table).

ALTER TABLE "drinks" ADD COLUMN "photo_url" TEXT;

CREATE TABLE "drink_photos" (
    "id" TEXT NOT NULL,
    "drink_id" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "drink_photos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "drink_photos_drink_id_key" ON "drink_photos"("drink_id");

ALTER TABLE "drink_photos" ADD CONSTRAINT "drink_photos_drink_id_fkey" FOREIGN KEY ("drink_id") REFERENCES "drinks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
