ALTER TABLE "participants"
ADD COLUMN "permissions" JSONB NOT NULL DEFAULT
'{"editing":true,"microphone":true,"camera":true,"screenShare":true,"raiseHand":true,"reactions":true,"chat":true,"fileUploads":true}'::jsonb;

ALTER TABLE "sessions"
ADD COLUMN "defaultPermissions" JSONB NOT NULL DEFAULT
'{"editing":true,"microphone":true,"camera":true,"screenShare":true,"raiseHand":true,"reactions":true,"chat":true,"fileUploads":true}'::jsonb;
