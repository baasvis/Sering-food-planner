-- CreateTable
CREATE TABLE "people" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT 'centraal',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "prerequisites" TEXT[],
    "required_for" TEXT[],
    "deeper_link" TEXT,
    "teaching_guide" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teaching_events" (
    "id" TEXT NOT NULL,
    "chunk_id" TEXT NOT NULL,
    "teacher_id" TEXT NOT NULL,
    "learner_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_email" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,

    CONSTRAINT "teaching_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teaching_events_chunk_id_idx" ON "teaching_events"("chunk_id");

-- CreateIndex
CREATE INDEX "teaching_events_teacher_id_idx" ON "teaching_events"("teacher_id");

-- CreateIndex
CREATE INDEX "teaching_events_learner_id_idx" ON "teaching_events"("learner_id");

-- AddForeignKey
ALTER TABLE "teaching_events" ADD CONSTRAINT "teaching_events_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "chunks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaching_events" ADD CONSTRAINT "teaching_events_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaching_events" ADD CONSTRAINT "teaching_events_learner_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
