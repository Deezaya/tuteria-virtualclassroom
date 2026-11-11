import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { getOptionalUser, getParticipantCookieId } from "../join/service.js";
import { readPermissions } from "../sessions/permissions.js";
import { createParticipantToken } from "../livekit/service.js";
import { publishBreakoutEvent } from "./events.js";
import { ClassRole } from "@prisma/client";

const paramsSchema = z.object({ sessionId: z.string().uuid() });
const roomParamsSchema = z.object({
  sessionId: z.string().uuid(),
  roomId: z.string().uuid(),
});
const roomNameSchema = z.string().trim().min(1).max(40);
const applySchema = z.object({
  rooms: z.array(z.object({
    id: z.string().uuid().optional(),
    name: roomNameSchema,
    participantIds: z.array(z.string().uuid()),
  })).max(10),
}).superRefine((value, context) => {
  const roomIds = value.rooms.flatMap((room) => room.id ? [room.id] : []);
  if (new Set(roomIds).size !== roomIds.length) {
    context.addIssue({ code: "custom", message: "Duplicate room id" });
  }
  const participantIds = value.rooms.flatMap((room) => room.participantIds);
  if (new Set(participantIds).size !== participantIds.length) {
    context.addIssue({ code: "custom", message: "A participant can only be in one room" });
  }
});
const renameSchema = z.object({ name: roomNameSchema });
const joinRoomSchema = z.object({ roomId: z.string().uuid().nullable() });
const announceSchema = z.object({ text: z.string().trim().min(1).max(300) });
const errorResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};
const declaredResponses = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  429: errorResponse,
  500: errorResponse,
};
const responseSchema = (properties: Record<string, object>, required: string[]) => ({
  type: "object",
  properties,
  required,
});

const security: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { participantCookieAuth: [] },
];

type RequestIdentity = { participantId: string | null; userId: string | null };

async function getRequestIdentity(request: FastifyRequest): Promise<RequestIdentity | null> {
  const participantId = getParticipantCookieId(request);
  if (participantId) return { participantId, userId: null };
  if (!request.cookies.token) return null;
  try {
    await request.jwtVerify();
  } catch {
    return null;
  }
  return request.user.sub ? { participantId: null, userId: request.user.sub } : null;
}

const sessionSelect = {
  id: true,
  spaceId: true,
  endedAt: true,
  breakoutRooms: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      name: true,
      createdAt: true,
      members: {
        where: {
          status: "admitted" as const,
          classRole: { in: ["student", "guest"] as ClassRole[] },
        },
        orderBy: { joinedAt: "asc" as const },
        select: {
          id: true,
          displayName: true,
          classRole: true,
        },
      },
    },
  },
  participants: {
    where: { status: "admitted" as const },
    orderBy: { joinedAt: "desc" as const },
    select: {
      id: true,
      sessionId: true,
      userId: true,
      displayName: true,
      classRole: true,
      status: true,
      permissions: true,
      breakoutRoomId: true,
      user: { select: { id: true, name: true, role: true } },
    },
  },
} as const;

async function loadSession(request: FastifyRequest, sessionId: string) {
  const identity = await getRequestIdentity(request);
  if (!identity) return { kind: "unauthenticated" as const };
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: sessionSelect,
  });
  if (!session) return { kind: "not-found" as const };
  const caller = session.participants.find((participant) =>
    identity.participantId
      ? participant.id === identity.participantId
      : participant.userId === identity.userId,
  );
  if (!caller) return { kind: "forbidden" as const };
  if (caller.status !== "admitted" || session.endedAt) {
    return { kind: "forbidden" as const };
  }
  return { kind: "ok" as const, session, caller };
}

function isHost(
  caller: { classRole: string; user: { role: string } | null },
): boolean {
  return (
    (caller.classRole === "admin" || caller.classRole === "tutor") &&
    (caller.user?.role === "admin" || caller.user?.role === "tutor")
  );
}

function sendLoadError(
  reply: FastifyReply,
  kind: "unauthenticated" | "not-found" | "forbidden",
) {
  if (kind === "unauthenticated") return reply.code(401).send({ message: "Authentication required" });
  if (kind === "not-found") return reply.code(404).send({ message: "Session not found" });
  return reply.code(403).send({ message: "Access not available" });
}

async function rateLimitKey(request: FastifyRequest): Promise<string> {
  const user = await getOptionalUser(request);
  if (user) return `user:${user.id}`;
  const participantId = getParticipantCookieId(request);
  return participantId ? `participant:${participantId}` : `ip:${request.ip}`;
}

function writeRateLimit(max = 30) {
  return { max, timeWindow: "1 minute", hook: "preHandler" as const, keyGenerator: rateLimitKey };
}

const sessionParamsSchema = {
  type: "object",
  required: ["sessionId"],
  properties: { sessionId: { type: "string", format: "uuid" } },
};
const roomParamsJsonSchema = {
  type: "object",
  required: ["sessionId", "roomId"],
  properties: {
    sessionId: { type: "string", format: "uuid" },
    roomId: { type: "string", format: "uuid" },
  },
};

export const breakoutRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/sessions/:sessionId/breakouts",
    {
      schema: {
        tags: ["Breakout rooms"],
        summary: "Get breakout room state for the current participant",
        security,
        params: sessionParamsSchema,
        response: {
          200: responseSchema({
            rooms: { type: "array", items: { type: "object", additionalProperties: true } },
            unassigned: { type: "array", items: { type: "object", additionalProperties: true } },
            ownRoom: { type: "object", nullable: true, additionalProperties: true },
          }, ["rooms", "unassigned", "ownRoom"]),
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ message: "Invalid session id" });
      const result = await loadSession(request, parsed.data.sessionId);
      if (result.kind !== "ok") return sendLoadError(reply, result.kind);
      const member = (participant: typeof result.session.participants[number]) => ({
        id: participant.id,
        name: participant.displayName ?? participant.user?.name ?? "Guest",
        role: participant.classRole,
      });
      const ownRoom = result.session.breakoutRooms.find(
        (room) => room.id === result.caller.breakoutRoomId,
      );
      return reply.send({
        rooms: result.session.breakoutRooms.map((room) => ({
          id: room.id,
          name: room.name,
          memberCount: room.members.length,
          members: room.members.map((person) => ({
            id: person.id,
            name: person.displayName ?? "Guest",
            role: person.classRole,
          })),
        })),
        unassigned: result.session.participants
          .filter((participant) =>
            (participant.classRole === "student" || participant.classRole === "guest") &&
            participant.breakoutRoomId === null,
          )
          .map(member),
        ownRoom: ownRoom ? { id: ownRoom.id, name: ownRoom.name } : null,
      });
    },
  );

  app.post(
    "/sessions/:sessionId/breakouts",
    {
      config: { rateLimit: writeRateLimit() },
      schema: {
        tags: ["Breakout rooms"],
        summary: "Apply a complete breakout room arrangement",
        security,
        params: sessionParamsSchema,
        body: {
          type: "object",
          required: ["rooms"],
          properties: {
            rooms: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                required: ["name", "participantIds"],
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string", minLength: 1, maxLength: 40 },
                  participantIds: {
                    type: "array",
                    items: { type: "string", format: "uuid" },
                  },
                },
              },
            },
          },
        },
        response: {
          200: responseSchema({ message: { type: "string" } }, ["message"]),
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      const parsedBody = applySchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) {
        return reply.code(400).send({ message: "Invalid breakout arrangement" });
      }
      const result = await loadSession(request, parsedParams.data.sessionId);
      if (result.kind !== "ok") return sendLoadError(reply, result.kind);
      if (!isHost(result.caller)) return reply.code(403).send({ message: "Only an admin or tutor can manage breakout rooms" });

      const currentRoomIds = new Set(result.session.breakoutRooms.map((room) => room.id));
      const assignedParticipantIds = new Set(
        result.session.participants
          .filter((person) => person.classRole === "student" || person.classRole === "guest")
          .map((person) => person.id),
      );
      if (
        parsedBody.data.rooms.some((room) => room.id && !currentRoomIds.has(room.id)) ||
        parsedBody.data.rooms.some((room) =>
          room.participantIds.some((id) => !assignedParticipantIds.has(id)),
        )
      ) {
        return reply.code(400).send({ message: "Room or participant does not belong to this session" });
      }

      const priorRoomIds = result.session.breakoutRooms.map((room) => room.id);
      const finalRoomIds: string[] = [];
      await prisma.$transaction(async (transaction) => {
        for (const room of parsedBody.data.rooms) {
          if (room.id) {
            await transaction.breakoutRoom.update({
              where: { id: room.id },
              data: { name: room.name },
            });
            finalRoomIds.push(room.id);
          } else {
            const created = await transaction.breakoutRoom.create({
              data: { sessionId: parsedParams.data.sessionId, name: room.name },
              select: { id: true },
            });
            finalRoomIds.push(created.id);
          }
        }

        const removedRoomIds = priorRoomIds.filter((id) => !finalRoomIds.includes(id));
        if (removedRoomIds.length) {
          await transaction.breakoutRoom.deleteMany({
            where: { sessionId: parsedParams.data.sessionId, id: { in: removedRoomIds } },
          });
        }

        const assignableIds = [...assignedParticipantIds];
        if (assignableIds.length) {
          await transaction.participant.updateMany({
            where: { sessionId: parsedParams.data.sessionId, id: { in: assignableIds } },
            data: { breakoutRoomId: null },
          });
        }
        await transaction.participant.updateMany({
          where: { id: result.caller.id, sessionId: parsedParams.data.sessionId },
          data: { breakoutRoomId: null },
        });
        for (const [index, room] of parsedBody.data.rooms.entries()) {
          if (room.participantIds.length) {
            await transaction.participant.updateMany({
              where: {
                sessionId: parsedParams.data.sessionId,
                id: { in: room.participantIds },
                status: "admitted",
                classRole: { in: ["student", "guest"] },
              },
              data: { breakoutRoomId: finalRoomIds[index] },
            });
          }
        }
      });
      await publishBreakoutEvent(parsedParams.data.sessionId, [...priorRoomIds, ...finalRoomIds], {
        type: "state-changed",
      });
      return reply.send({ message: "Breakout arrangement applied" });
    },
  );

  app.patch(
    "/sessions/:sessionId/breakouts/:roomId",
    {
      config: { rateLimit: writeRateLimit() },
      schema: {
        tags: ["Breakout rooms"],
        summary: "Rename a breakout room",
        security,
        params: roomParamsJsonSchema,
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 40 } },
        },
        response: {
          200: responseSchema({ room: { type: "object", additionalProperties: true } }, ["room"]),
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const parsedParams = roomParamsSchema.safeParse(request.params);
      const parsedBody = renameSchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) return reply.code(400).send({ message: "Invalid room request" });
      const result = await loadSession(request, parsedParams.data.sessionId);
      if (result.kind !== "ok") return sendLoadError(reply, result.kind);
      if (!isHost(result.caller)) return reply.code(403).send({ message: "Only an admin or tutor can manage breakout rooms" });
      const room = result.session.breakoutRooms.find((item) => item.id === parsedParams.data.roomId);
      if (!room) return reply.code(404).send({ message: "Breakout room not found" });
      const updated = await prisma.breakoutRoom.update({
        where: { id: room.id },
        data: { name: parsedBody.data.name },
        select: { id: true, name: true },
      });
      await publishBreakoutEvent(parsedParams.data.sessionId, result.session.breakoutRooms.map((item) => item.id), {
        type: "state-changed",
      });
      return reply.send({ room: updated });
    },
  );

  app.delete(
    "/sessions/:sessionId/breakouts/:roomId",
    {
      config: { rateLimit: writeRateLimit() },
      schema: {
        tags: ["Breakout rooms"],
        summary: "Delete a breakout room and return its members to the main room",
        security,
        params: roomParamsJsonSchema,
        response: {
          200: responseSchema({ message: { type: "string" } }, ["message"]),
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const parsed = roomParamsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ message: "Invalid room id" });
      const result = await loadSession(request, parsed.data.sessionId);
      if (result.kind !== "ok") return sendLoadError(reply, result.kind);
      if (!isHost(result.caller)) return reply.code(403).send({ message: "Only an admin or tutor can manage breakout rooms" });
      if (!result.session.breakoutRooms.some((room) => room.id === parsed.data.roomId)) {
        return reply.code(404).send({ message: "Breakout room not found" });
      }
      await prisma.breakoutRoom.delete({
        where: { id: parsed.data.roomId },
      });
      await publishBreakoutEvent(parsed.data.sessionId, result.session.breakoutRooms.map((room) => room.id), {
        type: "state-changed",
      });
      return reply.send({ message: "Breakout room deleted" });
    },
  );

  app.post(
    "/sessions/:sessionId/breakouts/end",
    {
      config: { rateLimit: writeRateLimit() },
      schema: {
        tags: ["Breakout rooms"],
        summary: "End all breakout rooms and return everyone to the main room",
        security,
        params: sessionParamsSchema,
        response: {
          200: responseSchema({ message: { type: "string" } }, ["message"]),
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ message: "Invalid session id" });
      const result = await loadSession(request, parsed.data.sessionId);
      if (result.kind !== "ok") return sendLoadError(reply, result.kind);
      if (!isHost(result.caller)) return reply.code(403).send({ message: "Only an admin or tutor can end breakout rooms" });
      const roomIds = result.session.breakoutRooms.map((room) => room.id);
      await prisma.$transaction(async (transaction) => {
        await transaction.participant.updateMany({
          where: { sessionId: parsed.data.sessionId, breakoutRoomId: { not: null } },
          data: { breakoutRoomId: null },
        });
        await transaction.breakoutRoom.deleteMany({
          where: { sessionId: parsed.data.sessionId },
        });
      });
      await publishBreakoutEvent(parsed.data.sessionId, roomIds, { type: "state-changed" });
      return reply.send({ message: "Everyone returned to the main room" });
    },
  );

  app.post(
    "/sessions/:sessionId/breakouts/:roomId/spy-token",
    {
      config: { rateLimit: writeRateLimit() },
      schema: {
        tags: ["Breakout rooms"],
        summary: "Create a hidden, subscribe-only LiveKit token for a breakout room",
        security,
        params: roomParamsJsonSchema,
        response: {
          200: responseSchema({
            token: { type: "string" },
            url: { type: "string", format: "uri" },
          }, ["token", "url"]),
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const parsed = roomParamsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ message: "Invalid room id" });
      const result = await loadSession(request, parsed.data.sessionId);
      if (result.kind !== "ok") return sendLoadError(reply, result.kind);
      const permitted =
        isHost(result.caller) || result.caller.classRole === "observer";
      if (!permitted) return reply.code(403).send({ message: "Only admins, tutors, and observers can watch a room" });
      if (!result.session.breakoutRooms.some((room) => room.id === parsed.data.roomId)) {
        return reply.code(404).send({ message: "Breakout room not found" });
      }
      const token = await createParticipantToken(
        { ...result.caller, session: { ...result.session, endedAt: result.session.endedAt } },
        { roomName: `${parsed.data.sessionId}:${parsed.data.roomId}`, hidden: true },
      );
      return reply.send({ token, url: config.LIVEKIT_URL });
    },
  );

  app.post(
    "/sessions/:sessionId/breakouts/join",
    {
      config: { rateLimit: writeRateLimit() },
      schema: {
        tags: ["Breakout rooms"],
        summary: "Move the current admin or tutor to a breakout room or the main room",
        security,
        params: sessionParamsSchema,
        body: {
          type: "object",
          required: ["roomId"],
          properties: { roomId: { type: "string", format: "uuid", nullable: true } },
        },
        response: {
          200: responseSchema({
            token: { type: "string" },
            url: { type: "string", format: "uri" },
            permissions: { type: "object", additionalProperties: { type: "boolean" } },
            roomId: { type: "string", nullable: true },
          }, ["token", "url", "permissions", "roomId"]),
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      const parsedBody = joinRoomSchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) return reply.code(400).send({ message: "Invalid room request" });
      const result = await loadSession(request, parsedParams.data.sessionId);
      if (result.kind !== "ok") return sendLoadError(reply, result.kind);
      if (!isHost(result.caller)) return reply.code(403).send({ message: "Only an admin or tutor can join a breakout room" });
      if (
        parsedBody.data.roomId &&
        !result.session.breakoutRooms.some((room) => room.id === parsedBody.data.roomId)
      ) {
        return reply.code(404).send({ message: "Breakout room not found" });
      }
      const participant = await prisma.participant.update({
        where: { id: result.caller.id },
        data: { breakoutRoomId: parsedBody.data.roomId },
        select: {
          id: true,
          displayName: true,
          classRole: true,
          status: true,
          permissions: true,
          breakoutRoomId: true,
        },
      });
      const token = await createParticipantToken({
        ...participant,
        session: result.session,
      });
      return reply.send({
        token,
        url: config.LIVEKIT_URL,
        permissions: readPermissions(participant.permissions),
        roomId: participant.breakoutRoomId,
      });
    },
  );

  app.post(
    "/sessions/:sessionId/breakouts/announce",
    {
      config: { rateLimit: writeRateLimit(10) },
      schema: {
        tags: ["Breakout rooms"],
        summary: "Send a live announcement to everyone in the session",
        security,
        params: sessionParamsSchema,
        body: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", minLength: 1, maxLength: 300 } },
        },
        response: {
          200: responseSchema({ message: { type: "string" } }, ["message"]),
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      const parsedBody = announceSchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) return reply.code(400).send({ message: "Announcement must be 1 to 300 characters" });
      const result = await loadSession(request, parsedParams.data.sessionId);
      if (result.kind !== "ok") return sendLoadError(reply, result.kind);
      if (!isHost(result.caller)) return reply.code(403).send({ message: "Only an admin or tutor can send announcements" });
      await publishBreakoutEvent(
        parsedParams.data.sessionId,
        result.session.breakoutRooms.map((room) => room.id),
        {
          type: "announcement",
          tutorName: result.caller.displayName ?? result.caller.user?.name ?? "Tutor",
          text: parsedBody.data.text,
        },
      );
      return reply.send({ message: "Announcement sent" });
    },
  );
};
