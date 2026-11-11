import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { defaultPermissions } from "../sessions/permissions.js";
import { publishWaitingListChanged } from "../sessions/service.js";
import { emitJoinStatus, subscribeToJoinStatus } from "./events.js";
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
  sameSite: process.env.NODE_ENV === "production" ? ("none" as const) : ("strict" as const),
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
          429: errorResponse,
          404: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const parsed = joinBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid request body" });
      }

      const tokenHash = hashJoinToken(parsed.data.token);
      const [observerSpace, inviteSpace] = await Promise.all([
        prisma.space.findUnique({
          where: { observerTokenHash: tokenHash },
          select: { id: true, name: true },
        }),
        prisma.space.findUnique({
            where: { inviteTokenHash: tokenHash },
            select: { id: true, name: true },
        }),
      ]);
      const space = observerSpace ?? inviteSpace;

      if (!space) {
        return reply.code(404).send({ message: "Invalid link" });
      }

      const observer = observerSpace !== null;
      const now = new Date();
      const [user, latestSession] = await Promise.all([
        observer ? null : getOptionalUser(request),
        prisma.session.findFirst({
          where: { spaceId: space.id },
          orderBy: { startedAt: "desc" },
          select: { id: true, endedAt: true, defaultPermissions: true },
        }),
      ]);
      const currentParticipantId = getParticipantCookieId(request);
      if (!observer && latestSession && !latestSession.endedAt) {
        const previouslyRemoved = await prisma.participant.findFirst({
          where: {
            sessionId: latestSession.id,
            status: "removed",
            OR: [
              ...(currentParticipantId ? [{ id: currentParticipantId }] : []),
              ...(user ? [{ userId: user.id }] : []),
            ],
          },
          select: { id: true },
        });
        if (previouslyRemoved) {
          return reply.code(403).send({ message: "You were removed from this class" });
        }
      }
      if (!observer && currentParticipantId && latestSession) {
        const previouslyDenied = await prisma.participant.findFirst({
          where: {
            id: currentParticipantId,
            sessionId: latestSession.id,
            status: "denied",
          },
          select: { id: true, classRole: true, status: true },
        });
        if (previouslyDenied) {
          return reply.code(201).send({
            session: { id: latestSession.id, spaceId: space.id, spaceName: space.name },
            participant: previouslyDenied,
          });
        }
      }

      if (!observer && !user && !parsed.data.name) {
        return reply.code(400).send({ message: "A name is required for guests" });
      }

      const session =
        latestSession && !latestSession.endedAt
          ? latestSession
          : await prisma.session.create({
          data: { spaceId: space.id },
          select: { id: true, defaultPermissions: true },
        });

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

      const [participant] = await Promise.all([
        prisma.participant.create({
          data: {
            sessionId: session.id,
            userId: user?.id,
            displayName: observer ? null : user?.name ?? parsed.data.name,
            classRole,
            status,
            permissions: (session.defaultPermissions ?? defaultPermissions) as Prisma.InputJsonValue,
            admittedAt: status === "admitted" ? now : null,
            randomId: observer ? createObserverRandomId() : null,
          },
          select: { id: true, classRole: true, status: true },
        }),
        prisma.space.update({
          where: { id: space.id },
          data: { lastUsedAt: now },
        }),
      ]);

      if (status === "waiting") {
        void publishWaitingListChanged(session.id).catch((error: unknown) => {
          request.log.error(
            { err: error, sessionId: session.id },
            "Could not notify session hosts about a waiting guest.",
          );
        });
      }

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
    "/join/events",
    {
      schema: {
        tags: ["Join"],
        summary: "Stream join status changes for the current waiting guest",
        security: [{ participantCookieAuth: [] }],
        response: {
          200: {
            type: "string",
            description: "Server-sent join status events",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
              },
            },
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

      let active = false;
      let closed = false;
      const queuedStatuses: Array<"admitted" | "denied" | "removed"> = [];
      const raw = reply.raw;
      let keepAlive: ReturnType<typeof setInterval> | null = null;
      const sendStatus = (status: "admitted" | "denied" | "removed") => {
        if (active && !raw.destroyed) {
          raw.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);
        } else {
          queuedStatuses.push(status);
        }
      };
      const unsubscribe = subscribeToJoinStatus(participantId, sendStatus);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (keepAlive !== null) clearInterval(keepAlive);
        unsubscribe();
        raw.off("close", cleanup);
        request.raw.socket.off("close", cleanup);
      };

      let participant;
      try {
        participant = await prisma.participant.findUnique({
          where: { id: participantId },
          select: { classRole: true, status: true },
        });
      } catch (error) {
        unsubscribe();
        throw error;
      }

      if (
        !participant ||
        participant.classRole !== "guest" ||
        !["waiting", "admitted", "denied", "removed"].includes(participant.status)
      ) {
        cleanup();
        return reply.code(404).send({ message: "Join status not found" });
      }

      reply.hijack();
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": config.FRONTEND_ORIGIN,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
      });
      raw.flushHeaders();
      raw.write(": connected\n\n");
      active = true;
      raw.on("close", cleanup);
      request.raw.socket.on("close", cleanup);

      if (participant.status !== "waiting") {
        raw.write(`event: status\ndata: ${JSON.stringify({ status: participant.status })}\n\n`);
        cleanup();
        raw.end();
        return;
      }

      for (const status of queuedStatuses) {
        raw.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);
      }
      queuedStatuses.length = 0;
      keepAlive = setInterval(() => {
        if (!raw.destroyed) raw.write(": ping\n\n");
      }, 25_000);
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
              status: { type: "string", enum: ["waiting", "admitted", "denied", "removed"] },
              sessionId: { type: "string" },
              spaceId: { type: "string" },
              spaceName: { type: "string" },
              classRole: {
                type: "string",
                enum: ["admin", "tutor", "student", "guest", "observer"],
              },
            },
            required: ["status", "sessionId", "spaceId", "spaceName", "classRole"],
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
        select: {
          id: true,
          status: true,
          classRole: true,
          sessionId: true,
          session: { select: { spaceId: true, space: { select: { name: true } } } },
        },
      });
      if (
        !participant ||
        !["waiting", "admitted", "denied", "removed"].includes(participant.status)
      ) {
        return reply.code(404).send({ message: "Join status not found" });
      }

      return {
        status: participant.status,
        sessionId: participant.sessionId,
        spaceId: participant.session.spaceId,
        spaceName: participant.session.space.name,
        classRole: participant.classRole,
      };
    },
  );
};
