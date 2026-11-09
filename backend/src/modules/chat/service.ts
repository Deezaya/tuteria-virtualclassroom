import type { FastifyRequest } from "fastify";
import { prisma } from "../../db.js";
import { getParticipantCookieId } from "../join/service.js";

export async function findChatParticipant(
  request: FastifyRequest,
  sessionId: string,
) {
  const participantId = getParticipantCookieId(request);
  if (participantId) {
    return prisma.participant.findFirst({
      where: { id: participantId, sessionId },
      select: {
        id: true,
        displayName: true,
        classRole: true,
        status: true,
        permissions: true,
        session: { select: { spaceId: true } },
      },
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
    where: { sessionId, userId },
    orderBy: { joinedAt: "desc" },
    select: {
      id: true,
      displayName: true,
      classRole: true,
      status: true,
      permissions: true,
      session: { select: { spaceId: true } },
    },
  });
}
