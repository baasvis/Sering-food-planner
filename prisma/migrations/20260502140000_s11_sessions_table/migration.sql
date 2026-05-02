-- S11: persist auth sessions to Postgres
--
-- Previously sessions lived in routes/auth.ts as an in-process Map<string, AppUser>.
-- Every Railway redeploy / restart wiped them, so the cookie (7-day maxAge)
-- outlived its server-side counterpart and users had to log in again.
-- Result: the "i keep getting logged off" feedback loop noted as U1 in the
-- 2026-04-26 triage report.
--
-- The new sessions table is small and indexed on expiresAt so the daily
-- cleanup cron can DELETE stale rows efficiently.

CREATE TABLE "sessions" (
  "id"         TEXT      NOT NULL,
  "email"      TEXT      NOT NULL,
  "name"       TEXT      NOT NULL,
  "picture"    TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
