CREATE TABLE "spaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "creatorId" UUID NOT NULL,
    "inviteTokenHash" TEXT NOT NULL,
    "observerTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "spaces_inviteTokenHash_key" ON "spaces"("inviteTokenHash");
CREATE UNIQUE INDEX "spaces_observerTokenHash_key" ON "spaces"("observerTokenHash");
CREATE INDEX "spaces_creatorId_idx" ON "spaces"("creatorId");
CREATE INDEX "spaces_name_idx" ON "spaces"("name");

ALTER TABLE "spaces"
ADD CONSTRAINT "spaces_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
