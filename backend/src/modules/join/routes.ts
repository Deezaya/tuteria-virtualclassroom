import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import {
  createObserverRandomId,
  getOptionalUser,
  getParticipantCookieId,
  hashJoinToken,
} from "./service.js";

const joinBodySchema = z.object({
  token: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(120).optional(),
});

const errorResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

const participantCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: 8 * 60 * 60,
};

export const joinRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/join",
    {
      schema: {
        tags: ["Join"],
        summary: "Join a space using an invite or observer token",
        description:
          "Invite guests wait for admission. Signed-in users with invite links are admitted immediately. Observer links create hidden, unnamed observers.",
        body: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", minLength: 1, maxLength: 128 },
            name: {
              type: "string",
              minLength: 1,
              maxLength: 120,
              description: "Required for guests using an invite link; ignored for observers.",
            },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              session: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  spaceId: { type: "string" },
                  spaceName: { type: "string" },
                },
                required: ["id", "spaceId", "spaceName"],
              },
              participant: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  classRole: {
                    type: "string",
                    enum: ["admin", "tutor", "student", "guest", "observer"],
                  },
                  status: {
                    type: "string",
                    enum: ["waiting", "admitted", "denied", "left", "removed"],
                  },
                },
                required: ["id", "classRole", "status"],
              },
            },
            required: ["session", "participant"],
          },
          400: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const parsed = joinBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid request body" });
      }

      const tokenHash = hashJoinToken(parsed.data.token);
      const observerSpace = await prisma.space.findUnique({
        where: { observerTokenHash: tokenHash },
        select: { id: true, name: true },
      });
      const inviteSpace = observerSpace
        ? null
        : await prisma.space.findUnique({
            where: { inviteTokenHash: tokenHash },
            select: { id: true, name: true },
          });
      const space = observerSpace ?? inviteSpace;

      if (!space) {
        return reply.code(404).send({ message: "Invalid link" });
      }

      const observer = observerSpace !== null;
      const user = observer ? null : await getOptionalUser(request);
      if (!observer && !user && !parsed.data.name) {
        return reply.code(400).send({ message: "A name is required for guests" });
      }

      const now = new Date();
      const session =
        (await prisma.session.findFirst({
          where: { spaceId: space.id, endedAt: null },
          orderBy: { startedAt: "desc" },
          select: { id: true },
        })) ??
        (await prisma.session.create({
          data: { spaceId: space.id },
          select: { id: true },
        }));

      const classRole = observer
        ? "observer"
        : user?.role === "admin"
          ? "admin"
          : user?.role === "tutor"
            ? "tutor"
            : user
              ? "student"
              : "guest";
      const status = classRole === "guest" ? "waiting" : "admitted";

      const participant = await prisma.participant.create({
        data: {
          sessionId: session.id,
          userId: user?.id,
          displayName: observer ? null : user?.name ?? parsed.data.name,
          classRole,
          status,
          randomId: observer ? createObserverRandomId() : null,
        },
        select: { id: true, classRole: true, status: true },
      });

      await prisma.space.update({
        where: { id: space.id },
        data: { lastUsedAt: now },
      });

      return reply
        .code(201)
        .setCookie("participant", participant.id, {
          ...participantCookieOptions,
          signed: true,
        })
        .send({
          session: { id: session.id, spaceId: space.id, spaceName: space.name },
          participant,
        });
    },
  );

  app.get(
    "/join/status",
    {
      schema: {
        tags: ["Join"],
        summary: "Get the current participant's join status",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["waiting", "admitted", "denied"] },
              sessionId: { type: "string" },
            },
            required: ["status", "sessionId"],
          },
          401: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const participantId = getParticipantCookieId(request);
      if (!participantId) {
        return reply.code(401).send({ message: "Join session not found" });
      }

      const participant = await prisma.participant.findUnique({
        where: { id: participantId },
        select: { id: true, status: true, sessionId: true },
      });
      if (
        !participant ||
        !["waiting", "admitted", "denied"].includes(participant.status)
      ) {
        return reply.code(404).send({ message: "Join status not found" });
      }

      return { status: participant.status, sessionId: participant.sessionId };
    },
  );
};
