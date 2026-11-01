import { createHash, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../db.js";

export function hashJoinToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getOptionalUser(request: FastifyRequest) {
  if (!request.cookies.token) return null;

  try {
    await request.jwtVerify();
  } catch {
    return null;
  }

  const userId = request.user.sub;
  if (!userId) return null;

  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true },
  });
}

export function getParticipantCookieId(request: FastifyRequest): string | null {
  const cookie = request.cookies.participant;
  if (!cookie) return null;

  const unsigned = request.unsignCookie(cookie);
  if (!unsigned.valid || !z.string().uuid().safeParse(unsigned.value).success) {
    return null;
  }

  return unsigned.value;
}

export function createObserverRandomId(): string {
  return randomUUID();
}
