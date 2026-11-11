import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db.js";
import { authenticate, requireRoles } from "../../plugins/auth.js";
import { hashPassword, normalizeEmail, verifyPassword } from "./service.js";

const loginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const createUserBodySchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  role: z.enum(["admin", "tutor", "student"]),
  temporaryPassword: z.string().min(1),
});

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? ("none" as const) : ("strict" as const),
  path: "/",
};

function invalidBody(reply: FastifyReply) {
  return reply.code(400).send({ message: "Invalid request body" });
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/login",
    {
      schema: {
        tags: ["Authentication"],
        summary: "Log in",
        description: "Sets an HTTP-only token cookie when credentials are valid.",
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", description: "Email address (trimmed and lowercased)." },
            password: { type: "string", format: "password" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  email: { type: "string" },
                  role: { type: "string", enum: ["admin", "tutor", "student"] },
                },
                required: ["id", "name", "email", "role"],
              },
            },
            required: ["user"],
          },
          400: { description: "Invalid request body." },
          401: { description: "Invalid email or password." },
        },
      },
    },
    async (request, reply) => {
      const parsedBody = loginBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return invalidBody(reply);
      }

      const email = normalizeEmail(parsedBody.data.email);
      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          hashedPassword: true,
        },
      });

      if (!user?.hashedPassword) {
        return reply.code(401).send({ message: "invalid email or password" });
      }

      const passwordMatches = await verifyPassword(
        parsedBody.data.password,
        user.hashedPassword,
      );
      if (!passwordMatches) {
        return reply.code(401).send({ message: "invalid email or password" });
      }

      const token = await reply.jwtSign(
        { sub: user.id, name: user.name, email: user.email, role: user.role },
        { expiresIn: "8h" },
      );
      return reply
        .setCookie("token", token, { ...cookieOptions, maxAge: 8 * 60 * 60 })
        .send({
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
          },
        });
    },
  );

  app.get(
    "/auth/me",
    {
      preHandler: authenticate,
      schema: {
        tags: ["Authentication"],
        summary: "Get the current user",
        security: [{ cookieAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  email: { type: "string" },
                  role: { type: "string", enum: ["admin", "tutor", "student"] },
                },
                required: ["id", "name", "email", "role"],
              },
            },
            required: ["user"],
          },
          401: { description: "Missing or invalid login cookie." },
        },
      },
    },
    async (request, reply) => {
      if (!request.currentUser) {
        return reply.code(401).send({ message: "Unauthorized" });
      }
      return { user: request.currentUser };
    },
  );

  app.post(
    "/auth/logout",
    {
      schema: {
        tags: ["Authentication"],
        summary: "Log out",
        description: "Clears the login cookie in this browser.",
        response: {
          200: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.clearCookie("token", cookieOptions).send({ message: "Logged out" });
    },
  );

  app.post(
    "/users",
    {
      preHandler: requireRoles("admin"),
      schema: {
        tags: ["Users"],
        summary: "Create a user (admin only)",
        security: [{ cookieAuth: [] }],
        body: {
          type: "object",
          required: ["name", "email", "role", "temporaryPassword"],
          properties: {
            name: { type: "string" },
            email: { type: "string", description: "Email address (trimmed and lowercased)." },
            role: { type: "string", enum: ["admin", "tutor", "student"] },
            temporaryPassword: { type: "string", format: "password" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  email: { type: "string" },
                  role: { type: "string", enum: ["admin", "tutor", "student"] },
                },
                required: ["id", "name", "email", "role"],
              },
            },
            required: ["user"],
          },
          400: { description: "Invalid request body." },
          401: { description: "Missing or invalid login cookie." },
          403: { description: "Admin role required." },
          409: { description: "An account with that email already exists." },
          500: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      },
    },
    async (request, reply) => {
      const parsedBody = createUserBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return invalidBody(reply);
      }

      const email = normalizeEmail(parsedBody.data.email);
      const hashedPassword = await hashPassword(parsedBody.data.temporaryPassword);

      try {
        const user = await prisma.user.create({
          data: {
            name: parsedBody.data.name,
            email,
            role: parsedBody.data.role,
            hashedPassword,
          },
          select: { id: true, name: true, email: true, role: true },
        });
        return reply.code(201).send({ user });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          return reply.code(409).send({ message: "An account with that email already exists" });
        }
        throw error;
      }
    },
  );
};
 