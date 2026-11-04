import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireRoles } from "../../plugins/auth.js";
import {
  endCurrentSession,
  leaveSession,
  listWaitingGuests,
  updateWaitingGuestStatus,
} from "./service.js";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const participantParamsSchema = z.object({ id: z.string().uuid() });
const sessionListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  spaceId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).default(1),
});
const attendanceParamsSchema = z.object({ sessionId: z.string().uuid() });

const errorResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

const participantResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionId: { type: "string" },
    displayName: { type: "string", nullable: true },
    classRole: {
      type: "string",
      enum: ["admin", "tutor", "student", "guest", "observer"],
    },
    status: {
      type: "string",
      enum: ["waiting", "admitted", "denied", "left", "removed"],
    },
    joinedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "sessionId", "classRole", "status", "joinedAt"],
};

function invalidParams(reply: FastifyReply) {
  return reply.code(400).send({ message: "Invalid id" });
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/sessions",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Sessions"],
        summary: "List sessions and attendance summaries",
        security: [{ cookieAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            search: { type: "string", maxLength: 100 },
            spaceId: { type: "string", format: "uuid" },
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            page: { type: "integer", minimum: 1, default: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              sessions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    space: {
                      type: "object",
                      properties: { id: { type: "string" }, name: { type: "string" } },
                      required: ["id", "name"],
                    },
                    startedAt: { type: "string", format: "date-time" },
                    endedAt: { type: "string", format: "date-time", nullable: true },
                    durationMinutes: { type: "integer", nullable: true },
                    tutorName: { type: "string", nullable: true },
                    participantCount: { type: "integer", minimum: 0 },
                    status: { type: "string", enum: ["live", "ended"] },
                  },
                  required: [
                    "id",
                    "space",
                    "startedAt",
                    "endedAt",
                    "durationMinutes",
                    "tutorName",
                    "participantCount",
                    "status",
                  ],
                },
              },
              page: { type: "integer" },
              limit: { type: "integer" },
              hasMore: { type: "boolean" },
            },
            required: ["sessions", "page", "limit", "hasMore"],
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const parsed = sessionListQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ message: "Invalid session query" });
      if (!request.currentUser) {
        return reply.code(401).send({ message: "Authentication required" });
      }

      const { search, spaceId, from, to, page, limit } = parsed.data;
      const startedAt: { gte?: Date; lt?: Date } = {};
      if (from) startedAt.gte = new Date(`${from}T00:00:00.000Z`);
      if (to) {
        const toExclusive = new Date(`${to}T00:00:00.000Z`);
        toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
        startedAt.lt = toExclusive;
      }
      if (from && to && startedAt.gte && startedAt.lt && startedAt.gte >= startedAt.lt) {
        return reply.code(400).send({ message: "Invalid date range" });
      }

      const where = {
        ...(spaceId ? { spaceId } : {}),
        ...(Object.keys(startedAt).length ? { startedAt } : {}),
        ...(request.currentUser.role === "tutor"
          ? { space: { creatorId: request.currentUser.id } }
          : {}),
        ...(search
          ? {
              OR: [
                { space: { name: { contains: search, mode: "insensitive" as const } } },
                {
                  participants: {
                    some: {
                      OR: [
                        { displayName: { contains: search, mode: "insensitive" as const } },
                        { user: { is: { name: { contains: search, mode: "insensitive" as const } } } },
                      ],
                    },
                  },
                },
              ],
            }
          : {}),
      };

      const sessions = await prisma.session.findMany({
        where,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit + 1,
        select: {
          id: true,
          spaceId: true,
          startedAt: true,
          endedAt: true,
          space: { select: { id: true, name: true } },
          participants: {
            select: {
              id: true,
              userId: true,
              randomId: true,
              displayName: true,
              classRole: true,
              status: true,
              admittedAt: true,
              joinedAt: true,
              user: { select: { name: true } },
            },
          },
        },
      });

      const hasMore = sessions.length > limit;
      const rows = sessions.slice(0, limit).map((session) => {
        const seenPeople = new Set<string>();
        for (const participant of session.participants) {
          if (!participant.admittedAt || participant.classRole === "observer") continue;
          const identity = participant.userId
            ? `user:${participant.userId}`
            : participant.randomId
              ? `guest:${participant.randomId}`
              : `participant:${participant.id}`;
          seenPeople.add(identity);
        }

        const tutor = session.participants
          .filter((participant) =>
            participant.classRole === "tutor" || participant.classRole === "admin",
          )
          .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime())[0];
        const isLive = session.endedAt === null;

        return {
          id: session.id,
          space: session.space,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          durationMinutes: isLive
            ? null
            : Math.max(0, Math.floor((session.endedAt!.getTime() - session.startedAt.getTime()) / 60_000)),
          tutorName: tutor?.user?.name ?? tutor?.displayName ?? null,
          participantCount: seenPeople.size,
          status: isLive ? "live" as const : "ended" as const,
        };
      });

      return { sessions: rows, page, limit, hasMore };
    },
  );

  app.get(
    "/sessions/:sessionId/attendance",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Sessions"],
        summary: "Get attendance for a session",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              participants: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    role: { type: "string", enum: ["admin", "tutor", "student", "guest", "observer"] },
                    displayName: { type: "string" },
                    randomId: { type: "string", nullable: true },
                    joinedAt: { type: "string", format: "date-time" },
                    leftAt: { type: "string", format: "date-time", nullable: true },
                  },
                  required: ["role", "displayName", "randomId", "joinedAt", "leftAt"],
                },
              },
            },
            required: ["participants"],
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
      const parsed = attendanceParamsSchema.safeParse(request.params);
      if (!parsed.success) return invalidParams(reply);
      if (!request.currentUser) {
        return reply.code(401).send({ message: "Authentication required" });
      }

      const session = await prisma.session.findUnique({
        where: { id: parsed.data.sessionId },
        select: {
          id: true,
          space: { select: { creatorId: true } },
          participants: {
            orderBy: { joinedAt: "asc" },
            select: {
              classRole: true,
              displayName: true,
              randomId: true,
              joinedAt: true,
              leftAt: true,
              user: { select: { name: true } },
            },
          },
        },
      });
      if (!session) return reply.code(404).send({ message: "Session not found" });
      if (
        request.currentUser.role !== "admin" &&
        session.space.creatorId !== request.currentUser.id
      ) {
        return reply.code(403).send({ message: "Forbidden" });
      }

      const participants = session.participants
        .filter((participant) =>
          request.currentUser?.role === "admin" || participant.classRole !== "observer",
        )
        .map((participant) => ({
          role: participant.classRole,
          displayName: participant.classRole === "observer"
            ? "Observer"
            : participant.user?.name ?? participant.displayName ?? "Guest",
          randomId: participant.classRole === "observer" ? participant.randomId : null,
          joinedAt: participant.joinedAt,
          leftAt: participant.leftAt,
        }));

      return { participants };
    },
  );

  app.post(
    "/sessions/:sessionId/leave",
    {
      schema: {
        tags: ["Sessions"],
        summary: "Leave the session as the current participant",
        description:
          "Identifies the participant by the signed participant cookie or the authenticated login cookie.",
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
              status: { type: "string", enum: ["left"] },
              leftAt: { type: "string", format: "date-time", nullable: true },
            },
            required: ["status", "leftAt"],
          },
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) return invalidParams(reply);

      const result = await leaveSession(request, params.data.sessionId);
      if (result.kind === "unauthenticated") {
        return reply.code(401).send({ message: "Authentication required" });
      }
      if (result.kind === "not-found") {
        return reply.code(404).send({ message: "Participant not found in session" });
      }

      return { status: "left" as const, leftAt: result.leftAt };
    },
  );

  app.post(
    "/sessions/:sessionId/end",
    {
      schema: {
        tags: ["Sessions"],
        summary: "End a session (admitted tutor or admin participant only)",
        description:
          "Ends the session, marks its admitted and waiting participants as left, and deletes the matching LiveKit room.",
        security: [{ participantCookieAuth: [] }, { cookieAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) return invalidParams(reply);

      const result = await endCurrentSession(request, params.data.sessionId);
      if (result.kind === "not-found") {
        return reply.code(404).send({ message: "Session not found" });
      }
      if (result.kind === "forbidden") {
        return reply.code(403).send({ message: "Not allowed to end this session" });
      }

      return {
        message: result.kind === "already-ended" ? "Session already ended" : "Session ended",
      };
    },
  );

  app.get(
    "/sessions/:sessionId/waiting",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Sessions"],
        summary: "List waiting guests (tutors and admins only)",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              participants: {
                type: "array",
                items: participantResponse,
              },
            },
            required: ["participants"],
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
      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) return invalidParams(reply);

      const participants = await listWaitingGuests(params.data.sessionId);
      if (!participants) {
        return reply.code(404).send({ message: "Session not found" });
      }

      return { participants };
    },
  );

  app.post(
    "/participants/:id/admit",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Sessions"],
        summary: "Admit a waiting guest (tutors and admins only)",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: { participant: participantResponse },
            required: ["participant"],
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const params = participantParamsSchema.safeParse(request.params);
      if (!params.success) return invalidParams(reply);

      const result = await updateWaitingGuestStatus(params.data.id, "admitted");
      if (result.kind === "not-found") {
        return reply.code(404).send({ message: "Participant not found" });
      }
      if (result.kind === "conflict") {
        return reply.code(409).send({ message: "Participant is not a waiting guest" });
      }

      return { participant: result.participant };
    },
  );

  app.post(
    "/participants/:id/deny",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Sessions"],
        summary: "Deny a waiting guest (tutors and admins only)",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: { participant: participantResponse },
            required: ["participant"],
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const params = participantParamsSchema.safeParse(request.params);
      if (!params.success) return invalidParams(reply);

      const result = await updateWaitingGuestStatus(params.data.id, "denied");
      if (result.kind === "not-found") {
        return reply.code(404).send({ message: "Participant not found" });
      }
      if (result.kind === "conflict") {
        return reply.code(409).send({ message: "Participant is not a waiting guest" });
      }

      return { participant: result.participant };
    },
  );
};
