import { RoomServiceClient } from "livekit-server-sdk";
import { prisma } from "../../db.js";
import type { FastifyRequest } from "fastify";
import type { ParticipantStatus } from "@prisma/client";
import { config } from "../../config.js";
import {
  getOptionalUser,
  getParticipantCookieId,
} from "../join/service.js";

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
    return { kind: "left" as const, leftAt: participant.leftAt };
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
      return { kind: "left" as const, leftAt: current.leftAt };
    }
    return { kind: "not-found" as const };
  }

  return { kind: "left" as const, leftAt };
}

export async function endCurrentSession(
  request: FastifyRequest,
  sessionId: string,
): Promise<EndSessionResult> {
  const current = await findCurrentParticipant(request, sessionId);
  return endSession(sessionId, current.participant?.id ?? null);
}

type EndSessionResult =
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "ended" }
  | { kind: "already-ended" };

export async function endSession(
  sessionId: string,
  participantId: string | null,
): Promise<EndSessionResult> {
  const result = await prisma.$transaction(async (transaction) => {
    const session = await transaction.session.findUnique({
      where: { id: sessionId },
      select: { id: true, endedAt: true },
    });
    if (!session) return { kind: "not-found" as const };

    const participant = participantId
      ? await transaction.participant.findFirst({
          where: { id: participantId, sessionId },
          select: { id: true, classRole: true, status: true },
        })
      : null;
    if (
      !participant ||
      (participant.classRole !== "admin" && participant.classRole !== "tutor")
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

    return { kind: "ended" as const };
  });

  if (result.kind === "ended") {
    await deleteLiveKitRoomIfPresent(sessionId);
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
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });
  if (!session) return null;

  return prisma.participant.findMany({
    where: { sessionId, ...waitingGuestWhere },
    orderBy: { joinedAt: "asc" },
    select: participantSelect,
  });
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
