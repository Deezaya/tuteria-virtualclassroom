import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";
import { prisma } from "../../db.js";
import type { FastifyRequest } from "fastify";
import type { ParticipantStatus } from "@prisma/client";
import { config } from "../../config.js";
import {
  getOptionalUser,
  getParticipantCookieId,
} from "../join/service.js";
import { emitSessionEvent } from "../join/events.js";

const waitingGuestWhere = {
  classRole: "guest" as const,
  status: "waiting" as const,
};

const participantSelect = {
  id: true,
  sessionId: true,
  displayName: true,
  classRole: true,
  status: true,
  joinedAt: true,
};

const liveKitRoomService = new RoomServiceClient(
  config.LIVEKIT_URL,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

export async function publishWaitingListChanged(sessionId: string): Promise<void> {
  const [hosts, roomParticipants] = await Promise.all([
    prisma.participant.findMany({
      where: {
        sessionId,
        status: "admitted",
        classRole: { in: ["admin", "tutor"] },
      },
      select: { id: true },
    }),
    liveKitRoomService.listParticipants(sessionId),
  ]);
  const hostIds = new Set(hosts.map((host) => host.id));
  const destinationIdentities = roomParticipants
    .map((participant) => participant.identity)
    .filter((identity) => hostIds.has(identity));
  if (destinationIdentities.length === 0) return;

  await liveKitRoomService.sendData(
    sessionId,
    Buffer.from(JSON.stringify({ type: "refresh" })),
    DataPacket_Kind.RELIABLE,
    { topic: "waiting", destinationIdentities },
  );
}

type SessionParticipant = {
  id: string;
  status: string;
  leftAt: Date | null;
  classRole: string;
};

async function findCurrentParticipant(
  request: FastifyRequest,
  sessionId: string,
): Promise<{ authenticated: boolean; participant: SessionParticipant | null }> {
  const participantId = getParticipantCookieId(request);
  if (participantId) {
    const participant = await prisma.participant.findFirst({
      where: { id: participantId, sessionId },
      select: { id: true, status: true, leftAt: true, classRole: true },
    });
    return { authenticated: true, participant };
  }

  const user = await getOptionalUser(request);
  if (!user) return { authenticated: false, participant: null };

  const participant = await prisma.participant.findFirst({
    where: { sessionId, userId: user.id },
    orderBy: { joinedAt: "desc" },
    select: { id: true, status: true, leftAt: true, classRole: true },
  });
  return { authenticated: true, participant };
}

export async function leaveSession(
  request: FastifyRequest,
  sessionId: string,
) {
  const current = await findCurrentParticipant(request, sessionId);
  if (!current.authenticated) return { kind: "unauthenticated" as const };
  const participant = current.participant;
  if (!participant) return { kind: "not-found" as const };
  if (participant.status === "left") {
    return {
      kind: "left" as const,
      leftAt: participant.leftAt,
      participantId: participant.id,
      wasWaiting: false,
    };
  }

  const leftAt = new Date();
  const updated = await prisma.participant.updateMany({
    where: { id: participant.id, sessionId, status: { not: "left" } },
    data: { status: "left", leftAt },
  });

  if (updated.count === 0) {
    const current = await prisma.participant.findUnique({
      where: { id: participant.id },
      select: { status: true, leftAt: true },
    });
    if (current?.status === "left") {
      return {
        kind: "left" as const,
        leftAt: current.leftAt,
        participantId: participant.id,
        wasWaiting: false,
      };
    }
    return { kind: "not-found" as const };
  }

  return {
    kind: "left" as const,
    leftAt,
    participantId: participant.id,
    wasWaiting: participant.status === "waiting",
  };
}

export async function endCurrentSession(
  request: FastifyRequest,
  sessionId: string,
): Promise<EndSessionResult> {
  const current = await findCurrentParticipant(request, sessionId);
  if (!current.authenticated) return { kind: "unauthenticated" };
  return endSession(sessionId, current.participant?.id ?? null);
}

type EndSessionResult =
  | { kind: "unauthenticated" }
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "ended"; breakoutRoomIds: string[] }
  | { kind: "already-ended" };

export async function endSession(
  sessionId: string,
  participantId: string | null,
): Promise<EndSessionResult> {
  const result = await prisma.$transaction(async (transaction) => {
    const session = await transaction.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        endedAt: true,
        breakoutRooms: { select: { id: true } },
      },
    });
    if (!session) return { kind: "not-found" as const };

    const participant = participantId
      ? await transaction.participant.findFirst({
          where: { id: participantId, sessionId },
          select: {
            id: true,
            classRole: true,
            status: true,
            user: { select: { role: true } },
          },
        })
      : null;
    if (
      !participant ||
      (participant.classRole !== "admin" && participant.classRole !== "tutor") ||
      (participant.user?.role !== "admin" && participant.user?.role !== "tutor")
    ) {
      return { kind: "forbidden" as const };
    }

    if (session.endedAt) {
      return { kind: "already-ended" as const };
    }
    if (participant.status !== "admitted") {
      return { kind: "forbidden" as const };
    }

    const endedAt = new Date();
    const updateSession = await transaction.session.updateMany({
      where: { id: sessionId, endedAt: null },
      data: { endedAt, endedBy: participant.id },
    });
    if (updateSession.count === 0) {
      return { kind: "already-ended" as const };
    }

    await transaction.participant.updateMany({
      where: {
        sessionId,
        status: { in: ["admitted", "waiting"] },
      },
      data: { status: "left", leftAt: endedAt },
    });

    await transaction.participant.updateMany({
      where: { sessionId },
      data: { breakoutRoomId: null },
    });
    await transaction.breakoutRoom.deleteMany({
      where: { sessionId },
    });

    return {
      kind: "ended" as const,
      breakoutRoomIds: session.breakoutRooms.map((room) => room.id),
    };
  });

  if (result.kind === "ended") {
    emitSessionEvent(sessionId, { type: "session-ended" });
    await Promise.all(
      [sessionId, ...result.breakoutRoomIds.map((roomId) => `${sessionId}:${roomId}`)]
        .map(deleteLiveKitRoomIfPresent),
    );
  }

  return result;
}

async function deleteLiveKitRoomIfPresent(roomName: string): Promise<void> {
  try {
    await liveKitRoomService.deleteRoom(roomName);
  } catch (error) {
    const details =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; status?: unknown; message?: unknown })
        : {};
    const code = details.code;
    const status = details.status;
    const message =
      typeof details.message === "string" ? details.message.toLowerCase() : "";

    if (
      code === 5 ||
      code === "NOT_FOUND" ||
      status === 404 ||
      status === "NOT_FOUND" ||
      /room (does not exist|not found)/.test(message)
    ) {
      return;
    }
    throw error;
  }
}

export async function listWaitingGuests(sessionId: string) {
  type WaitingGuestRow = {
    id: string;
    sessionId: string;
    displayName: string | null;
    classRole: "guest";
    status: "waiting";
    joinedAt: Date | string;
  };
  type SessionWaitingRow = { participants: WaitingGuestRow[] };

  const [result] = await prisma.$queryRaw<SessionWaitingRow[]>`
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', p."id",
          'sessionId', p."sessionId",
          'displayName', p."displayName",
          'classRole', p."classRole",
          'status', p."status",
          'joinedAt', p."joinedAt"
        ) ORDER BY p."joinedAt" ASC
      ) FILTER (WHERE p."id" IS NOT NULL),
      '[]'::jsonb
    ) AS participants
    FROM "sessions" s
    LEFT JOIN "participants" p
      ON p."sessionId" = s."id"
      AND p."classRole" = 'guest'
      AND p."status" = 'waiting'
    WHERE s."id" = ${sessionId}::uuid
    GROUP BY s."id"
  `;
  if (!result) return null;

  return result.participants.map((participant) => ({
    ...participant,
    joinedAt: new Date(participant.joinedAt),
  }));
}

export async function updateWaitingGuestStatus(
  participantId: string,
  status: Extract<ParticipantStatus, "admitted" | "denied">,
) {
  const participant = await prisma.participant.findUnique({
    where: { id: participantId },
    select: { id: true, classRole: true, status: true },
  });
  if (!participant) return { kind: "not-found" as const };
  if (
    participant.classRole !== "guest" ||
    participant.status !== "waiting"
  ) {
    return { kind: "conflict" as const };
  }

  const updated = await prisma.participant.updateMany({
    where: { id: participantId, ...waitingGuestWhere },
    data: {
      status,
      ...(status === "admitted" ? { admittedAt: new Date() } : {}),
    },
  });
  if (updated.count === 0) return { kind: "conflict" as const };

  const updatedParticipant = await prisma.participant.findUnique({
    where: { id: participantId },
    select: participantSelect,
  });
  if (!updatedParticipant) return { kind: "not-found" as const };

  return { kind: "updated" as const, participant: updatedParticipant };
}
