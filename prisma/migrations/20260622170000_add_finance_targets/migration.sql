-- CreateTable
CREATE TABLE "finance_targets" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "config" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "finance_targets_pkey" PRIMARY KEY ("id")
);
