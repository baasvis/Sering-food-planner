-- CreateTable
CREATE TABLE "closed_services" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "closed_services_pkey" PRIMARY KEY ("id")
);
