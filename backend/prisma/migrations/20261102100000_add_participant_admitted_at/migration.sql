ALTER TABLE "participants" ADD COLUMN "admittedAt" TIMESTAMP(3);

UPDATE "participants"
SET "admittedAt" = "joinedAt"
WHERE "status" = 'admitted';
