import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { findChatParticipant } from "./service.js";
import { readPermissions } from "../sessions/permissions.js";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const sendBodySchema = z.object({
  body: z.string().trim().min(1).max(2000),
});
const historyQuerySchema = z.object({
  before: z.string().datetime().optional(),
});

const errorResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

const chatMessageSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    senderName: { type: "string", nullable: true },
    senderRole: {
      type: "string",
      enum: ["admin", "tutor", "student", "guest", "observer"],
    },
    participantId: { type: "string", format: "uuid" },
    body: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "senderName", "senderRole", "participantId", "body", "createdAt"],
};

const liveKitRoomService = new RoomServiceClient(
  config.LIVEKIT_URL,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);

export const chatRoutes: FastifyPluginAsync = async (app) => {
  const rateLimitIdentities = new WeakMap<FastifyRequest, string>();
  const checkSendRateLimit = app.createRateLimit({
    max: 20,
    timeWindow: "1 minute",
    keyGenerator: (request) =>
      rateLimitIdentities.get(request) ?? `ip:${request.ip}`,
  });

  app.post(
    "/sessions/:sessionId/chat",
    {
      schema: {
        tags: ["Chat"],
        summary: "Send a chat message",
        description:
          "Only admitted participants may send messages. Observers cannot send chat messages.",
        security: [{ participantCookieAuth: [] }, { cookieAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["body"],
          properties: { body: { type: "string", minLength: 1, maxLength: 2000 } },
        },
        response: {
          201: chatMessageSchema,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ message: "Invalid session id" });
      }
      const parsedBody = sendBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ message: "Message must be 1 to 2000 characters" });
      }

      const participant = await findChatParticipant(request, params.data.sessionId);
      if (!participant) {
        return reply.code(401).send({ message: "Admitted participant required" });
      }
      if (participant.status !== "admitted") {
        return reply.code(403).send({ message: "Admitted participant required" });
      }
      if (participant.classRole === "observer") {
        return reply.code(403).send({ message: "Observers cannot send chat messages" });
      }
      if (!readPermissions(participant.permissions).chat) {
        return reply.code(403).send({ message: "Chat has been turned off by the host" });
      }

      rateLimitIdentities.set(request, `participant:${participant.id}`);
      const rateLimit = await checkSendRateLimit(request);
      if (!rateLimit.isAllowed && rateLimit.isExceeded) {
        return reply.code(429).send({ message: "Chat message limit exceeded" });
      }

      const message = await prisma.chatMessage.create({
        data: {
          spaceId: participant.session.spaceId,
          sessionId: params.data.sessionId,
          participantId: participant.id,
          senderName: participant.displayName ?? "Participant",
          senderRole: participant.classRole,
          body: parsedBody.data.body,
        },
        select: {
          id: true,
          senderName: true,
          senderRole: true,
          participantId: true,
          body: true,
          createdAt: true,
        },
      });

      await liveKitRoomService.sendData(
        params.data.sessionId,
        Buffer.from(JSON.stringify(message)),
        DataPacket_Kind.RELIABLE,
        { topic: "chat" },
      );

      return reply.code(201).send(message);
    },
  );

  app.get(
    "/sessions/:sessionId/chat",
    {
      schema: {
        tags: ["Chat"],
        summary: "Get recent chat messages",
        description:
          "Returns the latest 100 messages from the admitted participant's space, oldest first. Observers may read chat history.",
        security: [{ participantCookieAuth: [] }, { cookieAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            before: {
              type: "string",
              format: "date-time",
              description: "Return messages created before this timestamp.",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              messages: { type: "array", items: chatMessageSchema },
            },
            required: ["messages"],
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ message: "Invalid session id" });
      }
      const query = historyQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ message: "Invalid chat cursor" });
      }

      const participant = await findChatParticipant(request, params.data.sessionId);
      if (!participant) {
        return reply.code(401).send({ message: "Admitted participant required" });
      }
      if (participant.status !== "admitted") {
        return reply.code(403).send({ message: "Admitted participant required" });
      }

      const messages = await prisma.chatMessage.findMany({
        where: {
          spaceId: participant.session.spaceId,
          ...(query.data.before
            ? { createdAt: { lt: new Date(query.data.before) } }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        select: {
          id: true,
          senderName: true,
          senderRole: true,
          participantId: true,
          body: true,
          createdAt: true,
        },
      });

      return {
        messages: messages.reverse().map((message) => ({
          ...message,
          senderName:
            message.senderRole === "observer" ? null : message.senderName,
        })),
      };
    },
  );
};
