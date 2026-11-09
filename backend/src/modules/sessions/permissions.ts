import {
  DataPacket_Kind,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import {
  removeBoardParticipant,
  updateBoardParticipantEditing,
} from "../boards/service.js";
import { emitJoinStatus } from "../join/events.js";
import { getParticipantCookieId } from "../join/service.js";

export const permissionKeys = [
  "editing",
  "microphone",
  "camera",
  "screenShare",
  "raiseHand",
  "reactions",
  "chat",
  "fileUploads",
] as const;

// raiseHand, reactions, and fileUploads are stored only until those features exist.
export type ClassPermissions = Record<(typeof permissionKeys)[number], boolean>;

export const defaultPermissions: ClassPermissions = {
  editing: true,
  microphone: true,
  camera: true,
  screenShare: true,
  raiseHand: true,
  reactions: true,
  chat: true,
  fileUploads: true,
};

export const partialPermissionsSchema = z
  .object(
    Object.fromEntries(permissionKeys.map((key) => [key, z.boolean().optional()])) as
      Record<(typeof permissionKeys)[number], z.ZodOptional<z.ZodBoolean>>,
  )
  .strict()
  .refine((value) => Object.keys(value).length > 0);

const liveKitRoomService = new RoomServiceClient(
  config.LIVEKIT_URL,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

export function readPermissions(value: unknown): ClassPermissions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...defaultPermissions };
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    permissionKeys.map((key) => [
      key,
      typeof record[key] === "boolean" ? record[key] : defaultPermissions[key],
    ]),
  ) as ClassPermissions;
}

export function allowedTrackSources(permissions: ClassPermissions): TrackSource[] {
  const sources: TrackSource[] = [];
  if (permissions.microphone) sources.push(TrackSource.MICROPHONE);
  if (permissions.camera) sources.push(TrackSource.CAMERA);
  if (permissions.screenShare) {
    sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  }
  return sources;
}

export async function findSessionHost(
  request: FastifyRequest,
  sessionId: string,
) {
  const participantId = getParticipantCookieId(request);
  if (participantId) {
    return prisma.participant.findFirst({
      where: {
        id: participantId,
        sessionId,
        status: "admitted",
        classRole: { in: ["admin", "tutor"] },
      },
      select: { id: true, sessionId: true },
    });
  }

  if (!request.cookies.token) return null;
  try {
    await request.jwtVerify();
  } catch {
    return null;
  }
  const userId = request.user.sub;
  if (!userId) return null;

  return prisma.participant.findFirst({
    where: {
      sessionId,
      userId,
      status: "admitted",
      classRole: { in: ["admin", "tutor"] },
    },
    select: { id: true, sessionId: true },
    orderBy: { joinedAt: "desc" },
  });
}

function isParticipantNotInRoom(error: unknown): boolean {
  const details =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; status?: unknown; message?: unknown })
      : {};
  const message =
    typeof details.message === "string" ? details.message.toLowerCase() : "";
  return (
    details.code === 5 ||
    details.code === "NOT_FOUND" ||
    details.status === 404 ||
    /participant.*(not found|does not exist)/.test(message)
  );
}

async function updateLiveParticipantPermissions(
  sessionId: string,
  participantId: string,
  permissions: ClassPermissions,
  changed: Partial<ClassPermissions>,
): Promise<void> {
  if (
    changed.microphone === undefined &&
    changed.camera === undefined &&
    changed.screenShare === undefined &&
    changed.chat === undefined
  ) {
    return;
  }

  const canPublishSources = allowedTrackSources(permissions);
  try {
    await liveKitRoomService.updateParticipant(sessionId, participantId, {
      permission: {
        canPublish: canPublishSources.length > 0,
        canPublishSources,
        canPublishData: permissions.chat,
        canSubscribe: true,
      },
    });
  } catch (error) {
    if (!isParticipantNotInRoom(error)) throw error;
  }
}

async function publishPermissions(
  sessionId: string,
  message: Record<string, unknown>,
  participantIds?: string[],
): Promise<void> {
  await liveKitRoomService.sendData(
    sessionId,
    Buffer.from(JSON.stringify(message)),
    DataPacket_Kind.RELIABLE,
    participantIds
      ? { topic: "permissions", destinationIdentities: participantIds }
      : { topic: "permissions" },
  );
}

export async function listSessionParticipants(sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, defaultPermissions: true },
  });
  if (!session) return null;

  const participants = await prisma.participant.findMany({
    where: {
      sessionId,
      status: "admitted",
      classRole: { not: "observer" },
    },
    orderBy: { joinedAt: "asc" },
    select: {
      id: true,
      displayName: true,
      classRole: true,
      permissions: true,
      user: { select: { name: true } },
    },
  });
  return {
    defaultPermissions: readPermissions(session.defaultPermissions),
    participants: participants.map((participant) => ({
      id: participant.id,
      name: participant.user?.name ?? participant.displayName ?? "Participant",
      role: participant.classRole,
      permissions: readPermissions(participant.permissions),
    })),
  };
}

export async function updateParticipantPermissions(
  sessionId: string,
  participantId: string,
  changes: Partial<ClassPermissions>,
) {
  const participant = await prisma.participant.findFirst({
    where: {
      id: participantId,
      sessionId,
      status: "admitted",
      classRole: { not: "observer" },
    },
    select: { id: true, permissions: true },
  });
  if (!participant) return null;

  const permissions = { ...readPermissions(participant.permissions), ...changes };
  await Promise.all([
    prisma.participant.update({
      where: { id: participant.id },
      data: { permissions },
    }),
    updateLiveParticipantPermissions(sessionId, participant.id, permissions, changes),
  ]);
  if (changes.editing !== undefined) {
    updateBoardParticipantEditing(participant.id, changes.editing);
  }
  await publishPermissions(
    sessionId,
    { participantId, permissions },
    [participantId],
  );
  return { id: participant.id, permissions };
}

export async function updateSessionDefaultPermissions(
  sessionId: string,
  changes: Partial<ClassPermissions>,
) {
  const [session, participants] = await Promise.all([
    prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, defaultPermissions: true },
    }),
    prisma.participant.findMany({
      where: {
        sessionId,
        status: { in: ["admitted", "waiting"] },
        classRole: { not: "observer" },
      },
      select: { id: true, status: true, permissions: true },
    }),
  ]);
  if (!session) return null;

  const defaultValues = { ...readPermissions(session.defaultPermissions), ...changes };
  const updatedParticipants = participants.map((participant) => ({
    id: participant.id,
    status: participant.status,
    permissions: { ...readPermissions(participant.permissions), ...changes },
  }));
  const admittedParticipants = updatedParticipants.filter(
    (participant) => participant.status === "admitted",
  );
  const databaseWrite = prisma.$transaction([
    prisma.session.update({
      where: { id: sessionId },
      data: { defaultPermissions: defaultValues },
    }),
    prisma.$executeRaw`
      UPDATE "participants"
      SET "permissions" = COALESCE("permissions", '{}'::jsonb) || ${JSON.stringify(changes)}::jsonb
      WHERE "sessionId" = ${sessionId}::uuid
        AND "status" IN ('admitted', 'waiting')
        AND "classRole" <> 'observer'
    `,
  ]);
  const liveUpdate = Promise.all(
    admittedParticipants.map((participant) =>
      updateLiveParticipantPermissions(
        sessionId,
        participant.id,
        participant.permissions,
        changes,
      ),
    ),
  );
  await Promise.all([databaseWrite, liveUpdate]);
  const editing = changes.editing;
  if (editing !== undefined) {
    admittedParticipants.forEach((participant) =>
      updateBoardParticipantEditing(participant.id, editing),
    );
  }
  await publishPermissions(sessionId, {
    scope: "everyone",
    permissions: changes,
  }, admittedParticipants
    .map((participant) => participant.id));
  return { permissions: defaultValues };
}

export async function muteSessionParticipant(
  sessionId: string,
  participantId: string,
  source: TrackSource.MICROPHONE | TrackSource.CAMERA,
): Promise<"not-found" | "muted"> {
  const participant = await prisma.participant.findFirst({
    where: {
      id: participantId,
      sessionId,
      status: "admitted",
      classRole: { not: "observer" },
    },
    select: { id: true },
  });
  if (!participant) return "not-found";

  try {
    const liveParticipant = await liveKitRoomService.getParticipant(
      sessionId,
      participantId,
    );
    const track = liveParticipant.tracks.find((item) => item.source === source);
    if (track) {
      await liveKitRoomService.mutePublishedTrack(
        sessionId,
        participantId,
        track.sid,
        true,
      );
      if (source === TrackSource.MICROPHONE) {
        await liveKitRoomService.sendData(
          sessionId,
          Buffer.from(JSON.stringify({ type: "microphone-muted" })),
          DataPacket_Kind.RELIABLE,
          { topic: "classroom-control", destinationIdentities: [participantId] },
        );
      }
    }
  } catch (error) {
    if (!isParticipantNotInRoom(error)) throw error;
  }
  return "muted";
}

export async function removeSessionParticipant(
  sessionId: string,
  participantId: string,
): Promise<"not-found" | "removed"> {
  const result = await prisma.participant.updateMany({
    where: {
      id: participantId,
      sessionId,
      status: "admitted",
      classRole: { not: "observer" },
    },
    data: { status: "removed", leftAt: new Date() },
  });
  if (result.count === 0) return "not-found";

  emitJoinStatus(participantId, "removed");
  removeBoardParticipant(participantId);
  try {
    await liveKitRoomService.removeParticipant(sessionId, participantId, {
      revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)),
    });
  } catch (error) {
    if (!isParticipantNotInRoom(error)) throw error;
  }
  return "removed";
}
