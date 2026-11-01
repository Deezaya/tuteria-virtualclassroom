import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../db.js";

export function createSpaceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSpaceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function findManageableSpace(
  request: FastifyRequest,
  reply: FastifyReply,
  spaceId: string,
): Promise<{ id: string; creatorId: string } | null> {
  const user = request.currentUser;
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { id: true, creatorId: true },
  });

  if (!space || (user?.role !== "admin" && space.creatorId !== user?.id)) {
    await reply.code(404).send({ message: "Space not found" });
    return null;
  }

  return space;
}
