import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { DataPacket_Kind, RoomServiceClient } from "livekit-server-sdk";
import { z } from "zod";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { getOptionalUser, getParticipantCookieId } from "../join/service.js";
import { emitSessionEvent, type SessionTimer } from "../join/events.js";
import { readPermissions } from "../sessions/permissions.js";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const handBodySchema = z.object({
  raised: z.boolean(),
  participantId: z.string().uuid().optional(),
}).strict();
const reactionBodySchema = z.object({
  emoji: z.enum(["👍", "👏", "❤️", "😂", "😮", "⭐"]),
}).strict();
const timerStartSchema = z.union([
  z.object({
    mode: z.literal("countdown"),
    durationMinutes: z.number().int().min(1).max(600),
  }).strict(),
  z.object({
    mode: z.literal("countdown"),
    endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  }).strict(),
  z.object({ mode: z.literal("stopwatch") }).strict(),
]);
const timerSchema = z.object({
  mode: z.enum(["countdown", "stopwatch"]),
  startedAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable(),
  label: z.string(),
});

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
const security: Array<Record<string, string[]>> = [{ participantCookieAuth: [] }, { cookieAuth: [] }];
const sessionParams = {
  type: "object",
  required: ["sessionId"],
  properties: { sessionId: { type: "string", format: "uuid" } },
};
const timerResponse = {
  type: "object",
  properties: {
    timer: {
      type: "object",
      nullable: true,
      properties: {
        mode: { type: "string", enum: ["countdown", "stopwatch"] },
        startedAt: { type: "string", format: "date-time" },
        endsAt: { type: "string", format: "date-time", nullable: true },
        label: { type: "string" },
      },
      required: ["mode", "startedAt", "endsAt", "label"],
    },
    serverNow: { type: "string", format: "date-time" },
  },
  required: ["timer", "serverNow"],
};
const messageResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

type SessionFeatureParticipant = {
  id: string;
  status: string;
  classRole: string;
  permissions: unknown;
  breakoutRoomId: string | null;
  user: { role: string } | null;
};
type SessionFeatureContext = {
  id: string;
  endedAt: Date | null;
  timer: unknown;
  breakoutRooms: Array<{ id: string }>;
  caller: SessionFeatureParticipant;
};
type FeatureResult =
  | { kind: "ok"; session: SessionFeatureContext }
  | { kind: "unauthenticated" | "not-found" | "forbidden" };
type TimerHandle = ReturnType<typeof setTimeout>;

const liveKitRoomService = new RoomServiceClient(
  config.LIVEKIT_URL,
  config.LIVEKIT_API_KEY,
  config.LIVEKIT_API_SECRET,
);
const timerHandles = new Map<string, { startedAt: string; timeout: TimerHandle }>();

async function loadSessionContext(
  request: FastifyRequest,
  sessionId: string,
): Promise<FeatureResult> {
  const participantId = getParticipantCookieId(request);
  const user = participantId ? null : await getOptionalUser(request);
  if (!participantId && !user) return { kind: "unauthenticated" };

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      endedAt: true,
      timer: true,
      breakoutRooms: { select: { id: true } },
    },
  });
  if (!session) return { kind: "not-found" };

  const caller = participantId
    ? await prisma.participant.findFirst({
        where: { id: participantId, sessionId },
        select: {
          id: true,
          status: true,
          classRole: true,
          permissions: true,
          breakoutRoomId: true,
          user: { select: { role: true } },
        },
      })
    : await prisma.participant.findFirst({
        where: { sessionId, userId: user!.id },
        orderBy: { joinedAt: "desc" },
        select: {
          id: true,
          status: true,
          classRole: true,
          permissions: true,
          breakoutRoomId: true,
          user: { select: { role: true } },
        },
      });
  if (!caller || caller.status !== "admitted" || session.endedAt) {
    return { kind: "forbidden" };
  }
  return { kind: "ok", session: { ...session, caller } };
}

function isHost(participant: SessionFeatureParticipant): boolean {
  return (
    (participant.classRole === "admin" || participant.classRole === "tutor") &&
    (participant.user?.role === "admin" || participant.user?.role === "tutor")
  );
}

function requestRateLimitKey(request: FastifyRequest): Promise<string> | string {
  const participantId = getParticipantCookieId(request);
  if (participantId) return `participant:${participantId}`;
  return getOptionalUser(request).then((user) =>
    user ? `user:${user.id}` : "unauthenticated",
  );
}

function featureRateLimit(max: number, timeWindow: number) {
  return {
    max,
    timeWindow,
    hook: "preHandler" as const,
    keyGenerator: requestRateLimitKey,
  };
}

function respondWithContextError(
  reply: FastifyReply,
  kind: "unauthenticated" | "not-found" | "forbidden",
) {
  if (kind === "unauthenticated") {
    return reply.code(401).send({ message: "Authentication required" });
  }
  if (kind === "not-found") {
    return reply.code(404).send({ message: "Session not found" });
  }
  return reply.code(403).send({ message: "Access not available" });
}

function readTimer(value: unknown): SessionTimer | null {
  const parsed = timerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function roomName(sessionId: string, breakoutRoomId: string | null): string {
  return breakoutRoomId ? `${sessionId}:${breakoutRoomId}` : sessionId;
}

function isMissingLiveKitParticipant(error: unknown): boolean {
  const details =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; status?: unknown; message?: unknown })
      : {};
  const message =
    typeof details.message === "string" ? details.message.toLowerCase() : "";
  return (
    details.code === 5 ||
    details.code === "NOT_FOUND" ||
    details.status === 404 ||
    /participant.*(not found|does not exist)/.test(message)
  );
}

async function publishTimerChanged(
  sessionId: string,
  timer: SessionTimer | null,
  serverNow = new Date(),
): Promise<void> {
  const serverNowIso = serverNow.toISOString();
  const event = { type: "timer-changed" as const, timer, serverNow: serverNowIso };
  emitSessionEvent(sessionId, event);

  const roomNames = [
    sessionId,
    ...(await prisma.breakoutRoom.findMany({
      where: { sessionId },
      select: { id: true },
    })).map((room) => `${sessionId}:${room.id}`),
  ];
  const rooms = await liveKitRoomService.listRooms(roomNames);
  const payload = Buffer.from(JSON.stringify(event));
  await Promise.all(
    rooms.map((room) =>
      liveKitRoomService.sendData(room.name, payload, DataPacket_Kind.RELIABLE, {
        topic: "timer",
      }),
    ),
  );
}

function cancelScheduledTimer(sessionId: string): void {
  const current = timerHandles.get(sessionId);
  if (!current) return;
  clearTimeout(current.timeout);
  timerHandles.delete(sessionId);
}

async function clearExpiredTimer(
  sessionId: string,
  startedAt: string,
): Promise<boolean> {
  const changed = await prisma.$executeRaw`
    UPDATE "sessions"
    SET "timer" = NULL
    WHERE "id" = ${sessionId}::uuid
      AND "endedAt" IS NULL
      AND "timer"->>'startedAt' = ${startedAt}
  `;
  if (changed === 0) return false;
  cancelScheduledTimer(sessionId);
  await publishTimerChanged(sessionId, null);
  return true;
}

function scheduleTimerExpiry(
  sessionId: string,
  timer: SessionTimer,
  onError: (error: unknown) => void,
): void {
  cancelScheduledTimer(sessionId);
  if (timer.mode !== "countdown" || timer.endsAt === null) return;
  const timeout = setTimeout(() => {
    void clearExpiredTimer(sessionId, timer.startedAt).catch(onError);
  }, Math.max(0, Date.parse(timer.endsAt) - Date.now()));
  timeout.unref?.();
  timerHandles.set(sessionId, { startedAt: timer.startedAt, timeout });
}

export async function initializeSessionTimers(
  logger: { error: (context: object, message: string) => void },
): Promise<void> {
  const sessions = await prisma.$queryRaw<Array<{ id: string; timer: unknown }>>`
    SELECT "id", "timer"
    FROM "sessions"
    WHERE "endedAt" IS NULL AND "timer" IS NOT NULL
  `;
  for (const session of sessions) {
    const timer = readTimer(session.timer);
    if (!timer) continue;
    if (timer.endsAt && Date.parse(timer.endsAt) <= Date.now()) {
      try {
        await clearExpiredTimer(session.id, timer.startedAt);
      } catch (error) {
        logger.error({ err: error, sessionId: session.id }, "Could not expire session timer.");
      }
    } else {
      scheduleTimerExpiry(session.id, timer, (error) => {
        logger.error({ err: error, sessionId: session.id }, "Could not expire session timer.");
      });
    }
  }
}

async function setParticipantHand(
  sessionId: string,
  participant: Pick<SessionFeatureParticipant, "id" | "breakoutRoomId">,
  raised: boolean,
): Promise<"updated" | "not-found"> {
  const raisedAt = raised ? new Date().toISOString() : "";
  try {
    await liveKitRoomService.updateParticipant(
      roomName(sessionId, participant.breakoutRoomId),
      participant.id,
      { attributes: { handRaised: raisedAt } },
    );
    return "updated";
  } catch (error) {
    if (isMissingLiveKitParticipant(error)) return "not-found";
    throw error;
  }
}

export const sessionFeatureRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/sessions/:sessionId/timer",
    {
      config: { rateLimit: featureRateLimit(60, 60_000) },
      schema: {
        tags: ["Session features"],
        summary: "Get the current session timer",
        security,
        params: sessionParams,
        response: { 200: timerResponse, ...declaredResponses },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ message: "Invalid session id" });
      try {
        const result = await loadSessionContext(request, params.data.sessionId);
        if (result.kind !== "ok") return respondWithContextError(reply, result.kind);
        let timer = readTimer(result.session.timer);
        const serverNow = new Date();
        if (timer?.endsAt && Date.parse(timer.endsAt) <= serverNow.getTime()) {
          const cleared = await clearExpiredTimer(params.data.sessionId, timer.startedAt);
          if (cleared) timer = null;
          else {
            const latest = await prisma.session.findUnique({
              where: { id: params.data.sessionId },
              select: { timer: true },
            });
            timer = readTimer(latest?.timer);
          }
        }
        return reply.send({ timer, serverNow: serverNow.toISOString() });
      } catch (error) {
        request.log.error({ err: error, sessionId: params.data.sessionId }, "Could not load session timer.");
        return reply.code(500).send({ message: "Could not load the session timer" });
      }
    },
  );

  app.post(
    "/sessions/:sessionId/timer",
    {
      config: { rateLimit: featureRateLimit(30, 60_000) },
      schema: {
        tags: ["Session features"],
        summary: "Start or replace the session timer",
        security,
        params: sessionParams,
        response: {
          200: timerResponse,
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      const body = timerStartSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ message: "Invalid timer settings" });
      }
      try {
        const result = await loadSessionContext(request, params.data.sessionId);
        if (result.kind !== "ok") return respondWithContextError(reply, result.kind);
        if (!isHost(result.session.caller)) {
          return reply.code(403).send({ message: "Only an admin or tutor can manage the timer" });
        }

        const serverNow = new Date();
        let timer: SessionTimer;
        if (body.data.mode === "stopwatch") {
          timer = {
            mode: "stopwatch",
            startedAt: serverNow.toISOString(),
            endsAt: null,
            label: "STOPWATCH",
          };
        } else if ("durationMinutes" in body.data) {
          timer = {
            mode: "countdown",
            startedAt: serverNow.toISOString(),
            endsAt: new Date(
              serverNow.getTime() + body.data.durationMinutes * 60_000,
            ).toISOString(),
            label: "TIME LEFT",
          };
        } else {
          const [hour, minute] = body.data.endTime.split(":").map(Number);
          const endsAt = new Date(serverNow);
          endsAt.setHours(hour, minute, 0, 0);
          if (endsAt.getTime() <= serverNow.getTime()) {
            return reply.code(400).send({ message: "End time must be later today" });
          }
          timer = {
            mode: "countdown",
            startedAt: serverNow.toISOString(),
            endsAt: endsAt.toISOString(),
            label: `UNTIL ${endsAt.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            })}`,
          };
        }

        const updated = await prisma.session.updateMany({
          where: { id: params.data.sessionId, endedAt: null },
          data: { timer },
        });
        if (updated.count === 0) {
          return reply.code(404).send({ message: "Session not found" });
        }
        scheduleTimerExpiry(params.data.sessionId, timer, (error) => {
          request.log.error(
            { err: error, sessionId: params.data.sessionId },
            "Could not expire session timer.",
          );
        });
        await publishTimerChanged(params.data.sessionId, timer, serverNow);
        return reply.send({ timer, serverNow: serverNow.toISOString() });
      } catch (error) {
        request.log.error({ err: error, sessionId: params.data.sessionId }, "Could not start session timer.");
        return reply.code(500).send({ message: "Could not start the session timer" });
      }
    },
  );

  app.delete(
    "/sessions/:sessionId/timer",
    {
      config: { rateLimit: featureRateLimit(30, 60_000) },
      schema: {
        tags: ["Session features"],
        summary: "Stop the session timer",
        security,
        params: sessionParams,
        response: {
          200: timerResponse,
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ message: "Invalid session id" });
      try {
        const result = await loadSessionContext(request, params.data.sessionId);
        if (result.kind !== "ok") return respondWithContextError(reply, result.kind);
        if (!isHost(result.session.caller)) {
          return reply.code(403).send({ message: "Only an admin or tutor can manage the timer" });
        }
        const serverNow = new Date();
        const updated = await prisma.$executeRaw`
          UPDATE "sessions"
          SET "timer" = NULL
          WHERE "id" = ${params.data.sessionId}::uuid AND "endedAt" IS NULL
        `;
        if (updated === 0) return reply.code(404).send({ message: "Session not found" });
        cancelScheduledTimer(params.data.sessionId);
        await publishTimerChanged(params.data.sessionId, null, serverNow);
        return reply.send({ timer: null, serverNow: serverNow.toISOString() });
      } catch (error) {
        request.log.error({ err: error, sessionId: params.data.sessionId }, "Could not stop session timer.");
        return reply.code(500).send({ message: "Could not stop the session timer" });
      }
    },
  );

  app.post(
    "/sessions/:sessionId/hand",
    {
      config: { rateLimit: featureRateLimit(30, 60_000) },
      schema: {
        tags: ["Session features"],
        summary: "Raise or lower a participant's hand",
        security,
        params: sessionParams,
        response: {
          200: {
            type: "object",
            properties: {
              participantId: { type: "string", format: "uuid" },
              raised: { type: "boolean" },
              raisedAt: { type: "string", format: "date-time", nullable: true },
            },
            required: ["participantId", "raised", "raisedAt"],
          },
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      const body = handBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ message: "Invalid hand request" });
      }
      try {
        const result = await loadSessionContext(request, params.data.sessionId);
        if (result.kind !== "ok") return respondWithContextError(reply, result.kind);
        const caller = result.session.caller;
        if (caller.classRole === "observer") {
          return reply.code(403).send({ message: "Observers cannot use raised hands" });
        }

        const targetId = body.data.participantId;
        if (body.data.raised && (targetId || !readPermissions(caller.permissions).raiseHand)) {
          return reply.code(403).send({ message: "You cannot raise a hand" });
        }
        if (targetId && (body.data.raised || targetId === caller.id || !isHost(caller))) {
          return reply.code(403).send({ message: "Only a tutor can lower another participant's hand" });
        }

        const target = targetId
          ? await prisma.participant.findFirst({
              where: {
                id: targetId,
                sessionId: params.data.sessionId,
                status: "admitted",
                classRole: { not: "observer" },
              },
              select: { id: true, breakoutRoomId: true },
            })
          : { id: caller.id, breakoutRoomId: caller.breakoutRoomId };
        if (!target) return reply.code(404).send({ message: "Participant not found" });
        const updateResult = await setParticipantHand(
          params.data.sessionId,
          target,
          body.data.raised,
        );
        if (updateResult === "not-found") {
          return reply.code(404).send({ message: "Participant is not in the current room" });
        }
        return reply.send({
          participantId: target.id,
          raised: body.data.raised,
          raisedAt: body.data.raised ? new Date().toISOString() : null,
        });
      } catch (error) {
        request.log.error({ err: error, sessionId: params.data.sessionId }, "Could not update raised hand.");
        return reply.code(500).send({ message: "Could not update the raised hand" });
      }
    },
  );

  app.post(
    "/sessions/:sessionId/reactions",
    {
      config: { rateLimit: featureRateLimit(1, 1500) },
      schema: {
        tags: ["Session features"],
        summary: "Send a reaction to the current room",
        security,
        params: sessionParams,
        response: {
          200: messageResponse,
          ...declaredResponses,
        },
      },
    },
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      const body = reactionBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ message: "Invalid reaction" });
      }
      try {
        const result = await loadSessionContext(request, params.data.sessionId);
        if (result.kind !== "ok") return respondWithContextError(reply, result.kind);
        const participant = result.session.caller;
        if (
          participant.classRole === "observer" ||
          !readPermissions(participant.permissions).reactions
        ) {
          return reply.code(403).send({ message: "You cannot send reactions" });
        }
        await liveKitRoomService.sendData(
          roomName(params.data.sessionId, participant.breakoutRoomId),
          Buffer.from(JSON.stringify({ participantId: participant.id, emoji: body.data.emoji })),
          DataPacket_Kind.LOSSY,
          { topic: "reaction" },
        );
        return reply.send({ message: "Reaction sent" });
      } catch (error) {
        request.log.error({ err: error, sessionId: params.data.sessionId }, "Could not send reaction.");
        return reply.code(500).send({ message: "Could not send the reaction" });
      }
    },
  );
};
