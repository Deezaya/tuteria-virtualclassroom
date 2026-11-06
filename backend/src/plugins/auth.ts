import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { prisma } from "../db.js";
import type { UserRole } from "@prisma/client";

export type AuthenticatedUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
};

declare module "fastify" {
  interface FastifyRequest {
    currentUser: AuthenticatedUser | null;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      name?: string;
      email?: string;
      role?: UserRole;
      classRole?: string;
      documentName?: string;
    };
    user: {
      sub: string;
      name?: string;
      email?: string;
      role?: UserRole;
    };
  }
}

function isUserRole(role: unknown): role is UserRole {
  return role === "admin" || role === "tutor" || role === "student";
}

export function registerAuthDecorators(app: FastifyInstance): void {
  app.decorateRequest("currentUser", null);
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.code(401).send({ message: "Unauthorized" });
    return;
  }

  const userId = request.user.sub;
  if (!userId) {
    await reply.code(401).send({ message: "Unauthorized" });
    return;
  }

  if (
    isUserRole(request.user.role) &&
    typeof request.user.name === "string" &&
    typeof request.user.email === "string"
  ) {
    request.currentUser = {
      id: userId,
      name: request.user.name,
      email: request.user.email,
      role: request.user.role,
    };
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true },
  });

  if (!user) {
    await reply.code(401).send({ message: "Unauthorized" });
    return;
  }

  request.currentUser = user;
}

export function requireRoles(
  ...allowedRoles: AuthenticatedUser["role"][]
): preHandlerHookHandler {
  return async (request, reply) => {
    await authenticate(request, reply);
    if (reply.sent) return;

    if (!request.currentUser || !allowedRoles.includes(request.currentUser.role)) {
      await reply.code(403).send({ message: "Forbidden" });
    }
  };
}
