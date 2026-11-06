import { Database } from "@hocuspocus/extension-database";
import { Server } from "@hocuspocus/server";
import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { prisma } from "../../db.js";

type BoardTokenPayload = {
  sub: string;
  classRole: string;
  documentName: string;
  exp: number;
};

const classRoles = new Set(["admin", "tutor", "student", "guest", "observer"]);

export function createBoardServer(app: FastifyInstance): Server {
  const database = new Database({
    async fetch({ documentName }) {
      const board = await prisma.board.findUnique({
        where: { name: documentName },
        select: { data: true },
      });
      return board?.data ?? null;
    },
    async store({ documentName, state }) {
      const data = Buffer.from(state);
      await prisma.board.upsert({
        where: { name: documentName },
        create: { name: documentName, data },
        update: { data },
      });
    },
  });

  return new Server({
    port: config.HOCUSPOCUS_PORT,
    debounce: 2000,
    maxDebounce: 10000,
    extensions: [database],
    async onAuthenticate({ token, documentName, connectionConfig }) {
      let payload: BoardTokenPayload;
      try {
        payload = await app.jwt.verify<BoardTokenPayload>(token);
      } catch {
        throw new Error("Invalid or expired board token");
      }

      if (
        typeof payload.sub !== "string" ||
        typeof payload.classRole !== "string" ||
        !classRoles.has(payload.classRole) ||
        typeof payload.documentName !== "string" ||
        payload.documentName !== documentName ||
        !Number.isInteger(payload.exp) ||
        payload.exp <= Math.floor(Date.now() / 1000)
      ) {
        throw new Error("Invalid or expired board token");
      }

      connectionConfig.readOnly = payload.classRole === "observer";
      return {
        participantId: payload.sub,
        classRole: payload.classRole,
        documentName: payload.documentName,
      };
    },
  });
}
