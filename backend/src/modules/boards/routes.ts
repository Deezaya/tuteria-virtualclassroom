import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { getOptionalUser, getParticipantCookieId } from "../join/service.js";
import { readPermissions } from "../sessions/permissions.js";

const paramsSchema = z.object({ sessionId: z.string().uuid() });

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
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ message: "Invalid session id" });
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

      const documentName = `space:${participant.session.spaceId}:main`;
      const token = await reply.jwtSign(
        {
          sub: participant.id,
          classRole: participant.classRole,
          editing:
            participant.classRole !== "observer" &&
            readPermissions(participant.permissions).editing,
          documentName,
        },
        { expiresIn: "10m" },
      );

      return reply.send({ token, documentName, expiresIn: 600 });
    },
  );
};
