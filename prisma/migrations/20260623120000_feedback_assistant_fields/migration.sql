-- AlterTable: structured fields for the AI feedback-intake assistant.
-- Backward-compatible: existing one-shot ("quick") feedback rows keep working
-- with the defaults below; assistant-distilled reports fill these in.
ALTER TABLE "feedback" ADD COLUMN "title" TEXT NOT NULL DEFAULT '';
ALTER TABLE "feedback" ADD COLUMN "severity" TEXT NOT NULL DEFAULT '';
ALTER TABLE "feedback" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'quick';
ALTER TABLE "feedback" ADD COLUMN "details" JSONB;
