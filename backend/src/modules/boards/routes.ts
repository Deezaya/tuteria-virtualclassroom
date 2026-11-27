import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { getOptionalUser, getParticipantCookieId } from "../join/service.js";
import { readPermissions } from "../sessions/permissions.js";
import { LOCKED_LAYER_SUFFIX } from "./service.js";

const paramsSchema = z.object({ sessionId: z.string().uuid() });
const bodySchema = z.object({
  roomId: z.string().uuid().optional(),
  spy: z.boolean().optional(),
  /** "locked": the board's locked layer, writable only by hosts. */
  layer: z.enum(["main", "locked"]).optional(),
}).optional();

const errorResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

export async function findCurrentParticipant(request: FastifyRequest, sessionId: string) {
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
            layer: { type: "string", enum: ["main", "locked"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              documentName: { type: "string" },
              expiresIn: { type: "integer" },
              participantId: { type: "string", format: "uuid" },
            },
            required: ["token", "documentName", "expiresIn", "participantId"],
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
      const boardName = roomId
        ? `${parsedParams.data.sessionId}:${roomId}`
        : `space:${participant.session.spaceId}:main`;
      const lockedLayer = parsedBody.data?.layer === "locked";
      const documentName = lockedLayer ? `${boardName}${LOCKED_LAYER_SUFFIX}` : boardName;
      const host = participant.classRole === "admin" || participant.classRole === "tutor";
      const token = await reply.jwtSign(
        {
          sub: participant.id,
          classRole: participant.classRole,
          // Hosts can always draw on their own board; only hosts can write
          // the locked layer. Spy views and observers are always read-only.
          editing:
            !spy &&
            participant.classRole !== "observer" &&
            (host || (!lockedLayer && readPermissions(participant.permissions).editing)),
          spy,
          documentName,
        },
        { expiresIn: "10m" },
      );

      return reply.send({
        token,
        documentName,
        expiresIn: 600,
        participantId: participant.id,
      });
    },
  );
};
