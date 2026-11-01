import { prisma } from "../../db.js";
import type { ParticipantStatus } from "@prisma/client";

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
    data: { status },
  });
  if (updated.count === 0) return { kind: "conflict" as const };

  const updatedParticipant = await prisma.participant.findUnique({
    where: { id: participantId },
    select: participantSelect,
  });
  if (!updatedParticipant) return { kind: "not-found" as const };

  return { kind: "updated" as const, participant: updatedParticipant };
}
