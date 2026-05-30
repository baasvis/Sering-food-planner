-- CreateTable
CREATE TABLE "ritual_completions" (
    "id" SERIAL NOT NULL,
    "loc" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "completed" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ritual_completions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ritual_completions_loc_date_key" ON "ritual_completions"("loc", "date");
