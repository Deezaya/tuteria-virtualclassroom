import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireRoles } from "../../plugins/auth.js";
import { createSpaceToken, hashSpaceToken } from "./service.js";

const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const renameSpaceSchema = createSpaceSchema;
const spaceParamsSchema = z.object({ spaceId: z.string().uuid() });
const searchQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
});

function invalidBody(reply: FastifyReply) {
  return reply.code(400).send({ message: "Invalid request body" });
}

function invalidParams(reply: FastifyReply) {
  return reply.code(400).send({ message: "Invalid space id" });
}

export const spaceRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/spaces",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Spaces"],
        summary: "Create a space",
        security: [{ cookieAuth: [] }],
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 120 } },
        },
        response: {
          201: { description: "Space created." },
          400: { description: "Invalid request body." },
          401: { description: "Authentication required." },
          403: { description: "Admin or tutor role required." },
        },
      },
    },
    async (request, reply) => {
      const parsed = createSpaceSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      if (!request.currentUser) {
        return reply.code(401).send({ message: "Unauthorized" });
      }

      const space = await prisma.space.create({
        data: {
          name: parsed.data.name,
          creatorId: request.currentUser.id,
          inviteTokenHash: hashSpaceToken(createSpaceToken()),
          observerTokenHash: hashSpaceToken(createSpaceToken()),
        },
        select: {
          id: true,
          name: true,
          creatorId: true,
          createdAt: true,
          lastUsedAt: true,
        },
      });

      return reply.code(201).send({ space });
    },
  );

  app.get(
    "/spaces",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Spaces"],
        summary: "List spaces with optional name search",
        security: [{ cookieAuth: [] }],
        querystring: {
          type: "object",
          properties: { search: { type: "string", maxLength: 100 } },
        },
        response: {
          200: { description: "Spaces visible to the current admin or tutor." },
          400: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          401: { description: "Authentication required." },
          403: { description: "Admin or tutor role required." },
        },
      },
    },
    async (request, reply) => {
      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ message: "Invalid search query" });
      }
      if (!request.currentUser) {
        return reply.code(401).send({ message: "Unauthorized" });
      }

      const spaces = await prisma.space.findMany({
        where: {
          ...(request.currentUser.role === "admin"
            ? {}
            : { creatorId: request.currentUser.id }),
          ...(parsed.data.search
            ? { name: { contains: parsed.data.search, mode: "insensitive" } }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          creatorId: true,
          createdAt: true,
          lastUsedAt: true,
        },
      });

      return { spaces };
    },
  );

  app.patch(
    "/spaces/:spaceId",
    {
      preHandler: requireRoles("admin", "tutor"),
      schema: {
        tags: ["Spaces"],
        summary: "Rename a space (creator or admin)",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["spaceId"],
          properties: { spaceId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 120 } },
        },
        response: {
          200: { description: "Space renamed." },
          400: { description: "Invalid request." },
          401: { description: "Authentication required." },
          403: { description: "Admin or tutor role required." },
          404: { description: "Space not found." },
        },
      },
    },
    async (request, reply) => {
      const params = spaceParamsSchema.safeParse(request.params);
      if (!params.success) return invalidParams(reply);
      const body = renameSpaceSchema.safeParse(request.body);
      if (!body.success) return invalidBody(reply);
      if (!request.currentUser) {
        return reply.code(401).send({ message: "Unauthorized" });
      }

      const existing = await prisma.space.findUnique({
        where: { id: params.data.spaceId },
        select: { id: true, creatorId: true },
      });
      if (
        !existing ||
        (request.currentUser.role !== "admin" &&
          existing.creatorId !== request.currentUser.id)
      ) {
        return reply.code(404).send({ message: "Space not found" });
      }

      const space = await prisma.space.update({
        where: { id: existing.id },
        data: { name: body.data.name },
        select: {
          id: true,
          name: true,
          creatorId: true,
          createdAt: true,
          lastUsedAt: true,
        },
      });
      return { space };
    },
  );

  app.delete(
    "/spaces/:spaceId",
    {
      preHandler: requireRoles("admin"),
      schema: {
        tags: ["Spaces"],
        summary: "Delete a space (admin only)",
        security: [{ cookieAuth: [] }],
        params: {
          type: "object",
          required: ["spaceId"],
          properties: { spaceId: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
          400: { description: "Invalid space id." },
          401: { description: "Authentication required." },
          403: { description: "Admin role required." },
          404: { description: "Space not found." },
        },
      },
    },
    async (request, reply) => {
      const params = spaceParamsSchema.safeParse(request.params);
      if (!params.success) return invalidParams(reply);

      const deleted = await prisma.space.deleteMany({
        where: { id: params.data.spaceId },
      });
      if (deleted.count === 0) {
        return reply.code(404).send({ message: "Space not found" });
      }
      return { message: "Space deleted" };
    },
  );
};
