import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { requireRoles } from "../../plugins/auth.js";
import {
  listWaitingGuests,
  updateWaitingGuestStatus,
} from "./service.js";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const participantParamsSchema = z.object({ id: z.string().uuid() });

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
