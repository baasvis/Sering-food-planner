-- Clean orphaned parent references before adding FK
UPDATE "batches" SET "parent_id" = NULL
WHERE "parent_id" IS NOT NULL
  AND "parent_id" NOT IN (SELECT "id" FROM "batches");

-- CreateIndex
CREATE INDEX "batches_location_idx" ON "batches"("location");

-- CreateIndex
CREATE INDEX "batches_cook_date_idx" ON "batches"("cook_date");

-- CreateIndex
CREATE INDEX "feedback_processed_idx" ON "feedback"("processed");

-- CreateIndex
CREATE INDEX "ingredients_active_idx" ON "ingredients"("active");

-- CreateIndex
CREATE INDEX "ingredients_category_idx" ON "ingredients"("category");

-- CreateIndex
CREATE INDEX "log_timestamp_idx" ON "log"("timestamp");

-- CreateIndex
CREATE INDEX "recipe_index_type_idx" ON "recipe_index"("type");

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
