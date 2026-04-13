-- CreateTable
CREATE TABLE "telemetry_event" (
    "id" SERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data" JSONB,
    "user_id" TEXT,
    "session_id" TEXT,

    CONSTRAINT "telemetry_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_insight" (
    "id" SERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "status" TEXT NOT NULL DEFAULT 'new',
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "ai_insight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telemetry_event_timestamp_idx" ON "telemetry_event"("timestamp");

-- CreateIndex
CREATE INDEX "telemetry_event_type_timestamp_idx" ON "telemetry_event"("type", "timestamp");

-- CreateIndex
CREATE INDEX "telemetry_event_source_type_idx" ON "telemetry_event"("source", "type");

-- CreateIndex
CREATE INDEX "ai_insight_status_timestamp_idx" ON "ai_insight"("status", "timestamp");

-- CreateIndex
CREATE INDEX "ai_insight_category_idx" ON "ai_insight"("category");
