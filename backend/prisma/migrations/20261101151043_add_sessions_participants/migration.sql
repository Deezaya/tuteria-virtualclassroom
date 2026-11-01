-- CreateEnum
CREATE TYPE "ClassRole" AS ENUM ('admin', 'tutor', 'student', 'guest', 'observer');

-- CreateEnum
CREATE TYPE "ParticipantStatus" AS ENUM ('waiting', 'admitted', 'denied', 'left', 'removed');

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "spaceId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedBy" UUID,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL,
    "userId" UUID,
    "displayName" TEXT,
    "classRole" "ClassRole" NOT NULL,
    "status" "ParticipantStatus" NOT NULL,
    "randomId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_spaceId_endedAt_idx" ON "sessions"("spaceId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "participants_randomId_key" ON "participants"("randomId");

-- CreateIndex
CREATE INDEX "participants_sessionId_status_idx" ON "participants"("sessionId", "status");

-- CreateIndex
CREATE INDEX "participants_userId_idx" ON "participants"("userId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
