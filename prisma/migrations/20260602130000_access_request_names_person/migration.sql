-- First/last name on access requests (collected at request time, editable by a
-- director) + a link to the Training (competencies) person auto-created on
-- approval. All additive and nullable — existing rows (and the auto-queue
-- fallback, which only has the Google name) keep working.

-- AlterTable
ALTER TABLE "access_requests"
  ADD COLUMN "first_name" TEXT,
  ADD COLUMN "last_name" TEXT,
  ADD COLUMN "person_id" TEXT;
