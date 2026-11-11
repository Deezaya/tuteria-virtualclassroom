CREATE TABLE "breakout_rooms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "breakout_rooms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "breakout_rooms_sessionId_idx"
ON "breakout_rooms"("sessionId");

ALTER TABLE "participants"
ADD COLUMN "breakoutRoomId" UUID;

CREATE INDEX "participants_breakoutRoomId_idx"
ON "participants"("breakoutRoomId");

ALTER TABLE "breakout_rooms"
ADD CONSTRAINT "breakout_rooms_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "sessions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "participants"
ADD CONSTRAINT "participants_breakoutRoomId_fkey"
FOREIGN KEY ("breakoutRoomId") REFERENCES "breakout_rooms"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
