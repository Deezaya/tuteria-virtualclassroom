import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { prisma } from "../../db.js";
import { getOptionalUser, getParticipantCookieId } from "../join/service.js";
import { config } from "../../config.js";
import { createParticipantToken } from "./service.js";

const errorResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

async function findCurrentParticipant(request: FastifyRequest) {
  const participantId = getParticipantCookieId(request);
  if (participantId) {
    return prisma.participant.findUnique({
      where: { id: participantId },
      select: {
        id: true,
        displayName: true,
        classRole: true,
        status: true,
        session: {
          select: { id: true, endedAt: true, spaceId: true },
        },
      },
    });
  }

  const user = await getOptionalUser(request);
  if (!user) return null;

  return prisma.participant.findFirst({
    where: {
      userId: user.id,
      session: { endedAt: null },
    },
    orderBy: { joinedAt: "desc" },
    select: {
      id: true,
      displayName: true,
      classRole: true,
      status: true,
      session: {
        select: { id: true, endedAt: true, spaceId: true },
      },
    },
  });
}

export const livekitRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/livekit/token",
    {
      schema: {
        tags: ["LiveKit"],
        summary: "Create a LiveKit access token for the current participant",
        description:
          "Uses the signed participant cookie or the authenticated login cookie. Only admitted participants in a live session receive a token.",
        security: [{ participantCookieAuth: [] }, { cookieAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              url: { type: "string", format: "uri" },
            },
            required: ["token", "url"],
          },
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const participant = await findCurrentParticipant(request);
      if (!participant) {
        return reply.code(401).send({ message: "Authentication required" });
      }

      if (participant.status !== "admitted" || participant.session.endedAt) {
        return reply.code(403).send({ message: "Access not available" });
      }

      const token = await createParticipantToken(participant);
      return reply.send({ token, url: config.LIVEKIT_URL });
    },
  );
};
