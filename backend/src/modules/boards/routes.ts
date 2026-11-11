import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { getOptionalUser, getParticipantCookieId } from "../join/service.js";
import { readPermissions } from "../sessions/permissions.js";

const paramsSchema = z.object({ sessionId: z.string().uuid() });
const bodySchema = z.object({
  roomId: z.string().uuid().optional(),
  spy: z.boolean().optional(),
}).optional();

const errorResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

async function findCurrentParticipant(request: FastifyRequest, sessionId: string) {
  const participantId = getParticipantCookieId(request);
  if (participantId) {
    return prisma.participant.findUnique({
      where: { id: participantId },
      select: {
        id: true,
        sessionId: true,
        classRole: true,
        status: true,
        permissions: true,
        breakoutRoomId: true,
        user: { select: { role: true } },
        session: { select: { id: true, spaceId: true, endedAt: true } },
      },
    });
  }

  const user = await getOptionalUser(request);
  if (!user) return null;

  return prisma.participant.findFirst({
    where: { userId: user.id, sessionId },
    orderBy: { joinedAt: "desc" },
    select: {
      id: true,
      sessionId: true,
      classRole: true,
      status: true,
      permissions: true,
      breakoutRoomId: true,
      user: { select: { role: true } },
      session: { select: { id: true, spaceId: true, endedAt: true } },
    },
  });
}

export const boardRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/boards/:sessionId/token",
    {
      schema: {
        tags: ["Boards"],
        summary: "Create a short-lived access token for a session whiteboard",
        description:
          "Only admitted participants in the requested live session can access its whiteboard. Observers receive read-only access.",
        security: [{ participantCookieAuth: [] }, { cookieAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: {
            roomId: { type: "string", format: "uuid" },
            spy: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              documentName: { type: "string" },
              expiresIn: { type: "integer" },
            },
            required: ["token", "documentName", "expiresIn"],
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ message: "Invalid session id" });
      }
      const parsedBody = bodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: "Invalid board request" });
      }

      const participant = await findCurrentParticipant(request, parsedParams.data.sessionId);
      if (!participant) {
        return reply.code(401).send({ message: "Authentication required" });
      }

      if (
        participant.sessionId !== parsedParams.data.sessionId ||
        participant.status !== "admitted" ||
        participant.session.endedAt
      ) {
        return reply.code(403).send({ message: "Access not available" });
      }

      const requestedRoomId = parsedBody.data?.roomId ?? null;
      const spy = parsedBody.data?.spy === true;
      const hostAccount =
        (participant.classRole === "admin" || participant.classRole === "tutor") &&
        (participant.user?.role === "admin" || participant.user?.role === "tutor");
      if (
        spy &&
        !hostAccount &&
        participant.classRole !== "observer"
      ) {
        return reply.code(403).send({ message: "Access not available" });
      }
      const roomId = requestedRoomId ?? participant.breakoutRoomId;
      if (roomId && roomId !== participant.breakoutRoomId) {
        if (!spy || (!hostAccount && participant.classRole !== "observer")) {
          return reply.code(403).send({ message: "Access not available" });
        }
      }
      if (roomId) {
        const room = await prisma.breakoutRoom.findFirst({
          where: { id: roomId, sessionId: parsedParams.data.sessionId },
          select: { id: true },
        });
        if (!room) return reply.code(404).send({ message: "Breakout room not found" });
      }
      const documentName = roomId
        ? `${parsedParams.data.sessionId}:${roomId}`
        : `space:${participant.session.spaceId}:main`;
      const token = await reply.jwtSign(
        {
          sub: participant.id,
          classRole: participant.classRole,
          editing:
            !spy &&
            participant.classRole !== "observer" &&
            readPermissions(participant.permissions).editing,
          spy,
          documentName,
        },
        { expiresIn: "10m" },
      );

      return reply.send({ token, documentName, expiresIn: 600 });
    },
  );
};
