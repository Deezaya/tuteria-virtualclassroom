CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "spaceId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderRole" "ClassRole" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_messages_spaceId_createdAt_idx"
ON "chat_messages"("spaceId", "createdAt");

ALTER TABLE "chat_messages"
ADD CONSTRAINT "chat_messages_spaceId_fkey"
FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_messages"
ADD CONSTRAINT "chat_messages_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "sessions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_messages"
ADD CONSTRAINT "chat_messages_participantId_fkey"
FOREIGN KEY ("participantId") REFERENCES "participants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
