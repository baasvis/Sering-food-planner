-- Role-based page permissions (frontend guardrails). A role maps each gateable
-- screen to hidden/view/edit; access_requests.role_id links a user to one role.
-- Additive and nullable — existing users (role_id NULL) keep full edit.

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "access_requests" ADD COLUMN "role_id" TEXT;
