-- CreateTable
CREATE TABLE "cook_rhythm" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "cook_rhythm_pkey" PRIMARY KEY ("id")
);
