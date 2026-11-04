import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { requireRoles } from "../../plugins/auth.js";
import { createSpaceToken, findManageableSpace, hashSpaceToken } from "../spaces/service.js";

const spaceParamsSchema = z.object({ spaceId: z.string().uuid() });
const resolveInviteSchema = z.object({
  token: z.string().min(1).max(128),
});

function invalidParams(reply: FastifyReply) {
  return reply.code(400).send({ message: "Invalid space id" });
}

async function createLink(
  request: FastifyRequest,
  reply: FastifyReply,
  kind: "invite" | "observer",
) {
  const parsedParams = spaceParamsSchema.safeParse(request.params);
  if (!parsedParams.success) return invalidParams(reply);

  const space = await findManageableSpace(request, reply, parsedParams.data.spaceId);
  if (!space) return;

  const token = createSpaceToken();
  const tokenHash = hashSpaceToken(token);
  const updated = await prisma.space.update({
    where: { id: space.id },
    data:
      kind === "invite"
        ? { inviteTokenHash: tokenHash }
        : { observerTokenHash: tokenHash },
    select: { id: true },
  });

  const query = new URLSearchParams({ token });
  if (kind === "observer") query.set("observer", "1");
  const link = `${config.FRONTEND_URL.replace(/\/$/, "")}/join?${query.toString()}`;

  return {
    spaceId: updated.id,
    link,
    message: "This link contains a one-time-visible token. Generate a new link if it is lost.",
  };
}

export const inviteRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/spaces/:spaceId/invite-link",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Invites"],
        summary: "Generate an invite link (creator or admin)",
        description:
          "Returns a frontend URL with a new long random token. Only its hash is stored; each call rotates and invalidates the previous invite link.",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["spaceId"],
          properties: { spaceId: { type: "string", format: "uuid" } },
        },
        response: {
          200: { description: "New invite link." },
          400: { description: "Invalid space id." },
          401: { description: "Authentication required." },
          403: { description: "Admin or tutor role required." },
          404: { description: "Space not found." },
        },
      },
    },
    async (request, reply) => {
      if (!request.currentUser) {
        return reply.code(401).send({ message: "Unauthorized" });
      }
      return createLink(request, reply, "invite");
    },
  );

  app.post(
    "/spaces/:spaceId/observer-link",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Invites"],
        summary: "Generate an observer link (creator or admin)",
        description:
          "Returns a frontend URL with a new long random observer token. Only its hash is stored; each call rotates and invalidates the previous observer link.",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["spaceId"],
          properties: { spaceId: { type: "string", format: "uuid" } },
        },
        response: {
          200: { description: "New observer link." },
          400: { description: "Invalid space id." },
          401: { description: "Authentication required." },
          403: { description: "Admin or tutor role required." },
          404: { description: "Space not found." },
        },
      },
    },
    async (request, reply) => {
      if (!request.currentUser) {
        return reply.code(401).send({ message: "Unauthorized" });
      }
      return createLink(request, reply, "observer");
    },
  );

  app.post(
    "/invites/resolve",
    {
      schema: {
        tags: ["Invites"],
        summary: "Resolve a public invite or observer token to its space",
        description:
          "The token is submitted in the request body and never stored in plaintext.",
        body: {
          type: "object",
          required: ["token"],
          properties: { token: { type: "string", minLength: 1, maxLength: 128 } },
        },
        response: {
          200: { description: "Invite is valid; returns the space id and name." },
          400: { description: "Invalid request body." },
          404: { description: "Invite not found or no longer valid." },
        },
      },
    },
    async (request, reply) => {
      const parsed = resolveInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid request body" });
      }

      const space = await prisma.space.findUnique({
        where: { inviteTokenHash: hashSpaceToken(parsed.data.token) },
        select: { id: true, name: true, inviteTokenHash: true },
      });
      if (!space) {
        const observerSpace = await prisma.space.findUnique({
          where: { observerTokenHash: hashSpaceToken(parsed.data.token) },
          select: { id: true, name: true },
        });
        if (!observerSpace) {
          return reply.code(404).send({ message: "Invite not found or no longer valid" });
        }
        return { space: { id: observerSpace.id, name: observerSpace.name } };
      }

      const updated = await prisma.space.updateMany({
        where: { id: space.id, inviteTokenHash: space.inviteTokenHash },
        data: { lastUsedAt: new Date() },
      });
      if (updated.count === 0) {
        return reply.code(404).send({ message: "Invite not found or no longer valid" });
      }

      return { space: { id: space.id, name: space.name } };
    },
  );
};
