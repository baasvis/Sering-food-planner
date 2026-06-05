-- Account-access request / approval workflow.
--
-- A new person who isn't on CONFIG.ALLOWED_EMAILS signs in with Google to
-- record a "pending" request (routes/auth.ts POST /auth/request-access). A
-- director approves it from the Team screen, flipping status to "approved",
-- after which the email joins the effective login allowlist (env list UNION
-- approved rows) — no env-var edit / redeploy. Approved users can be revoked.
-- Purely additive: the env allowlist and the production fail-closed boot
-- guard in server.ts are unchanged.

-- CreateTable
CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "picture" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_requests_email_key" ON "access_requests"("email");

-- CreateIndex
CREATE INDEX "access_requests_status_idx" ON "access_requests"("status");
