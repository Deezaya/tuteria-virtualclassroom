CREATE INDEX "sessions_spaceId_startedAt_idx"
ON "sessions"("spaceId", "startedAt");

CREATE INDEX "participants_sessionId_status_joinedAt_idx"
ON "participants"("sessionId", "status", "joinedAt");
