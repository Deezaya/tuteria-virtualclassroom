import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { isStorageConfigured, presignDownload, presignUpload } from "../../services/storage.js";
import { readPermissions } from "../sessions/permissions.js";
import { findCurrentParticipant } from "./routes.js";

/** Upload rules per kind of board file. */
const UPLOAD_KINDS = {
  image: { maxBytes: 10 * 1024 * 1024 },
  "pdf-page": { maxBytes: 8 * 1024 * 1024 },
} as const;
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const UPLOAD_EXPIRES = 600;
const VIEW_EXPIRES = 3600;
const KEY_PATTERN =
  /^spaces\/[0-9a-f-]{36}\/boards\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

const paramsSchema = z.object({ sessionId: z.uuid() });
const uploadSchema = z.object({
  kind: z.enum(["image", "pdf-page"]),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  bytes: z.number().int().positive(),
});
const urlsSchema = z.object({ keys: z.array(z.string().max(200)).min(1).max(100) });

const errorResponse = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

/** Board files: images and PDF pages stored in R2. */
export const boardUploadRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/boards/:sessionId/uploads",
    {
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: {
        tags: ["Boards"],
        summary: "Get a link to upload one board file to storage",
        description:
          "Images need editing plus the File uploads permission (tutors and admins always). PDF pages are for tutors and admins only. The link only accepts a file of the stated type and exact size.",
        security: [{ participantCookieAuth: [] }, { cookieAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["kind", "contentType", "bytes"],
          properties: {
            kind: { type: "string", enum: ["image", "pdf-page"] },
            contentType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] },
            bytes: { type: "integer", minimum: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              assetId: { type: "string" },
              key: { type: "string" },
              uploadUrl: { type: "string" },
              expiresIn: { type: "integer" },
            },
            required: ["assetId", "key", "uploadUrl", "expiresIn"],
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          413: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = uploadSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ message: "Invalid upload request" });
      }
      const participant = await findCurrentParticipant(request, params.data.sessionId);
      if (!participant) return reply.code(401).send({ message: "Authentication required" });
      if (
        participant.sessionId !== params.data.sessionId ||
        participant.status !== "admitted" ||
        participant.session.endedAt ||
        participant.classRole === "observer"
      ) {
        return reply.code(403).send({ message: "Access not available" });
      }

      const host = participant.classRole === "admin" || participant.classRole === "tutor";
      const permissions = readPermissions(participant.permissions);
      if (!host && !permissions.editing) {
        return reply.code(403).send({ message: "Your tutor has turned off editing." });
      }
      if (body.data.kind === "pdf-page" && !host) {
        return reply.code(403).send({ message: "Only tutors can add PDFs." });
      }
      if (body.data.kind === "image" && !host && !permissions.fileUploads) {
        return reply.code(403).send({ message: "Your tutor hasn't allowed file uploads." });
      }
      if (body.data.bytes > UPLOAD_KINDS[body.data.kind].maxBytes) {
        return reply.code(413).send({ message: "That file is too large." });
      }
      if (!isStorageConfigured()) {
        return reply.code(503).send({ message: "File storage isn't set up yet." });
      }

      const assetId = randomUUID();
      const key = `spaces/${participant.session.spaceId}/boards/${assetId}.${EXTENSIONS[body.data.contentType]}`;
      return reply.send({
        assetId,
        key,
        uploadUrl: presignUpload(key, body.data.contentType, body.data.bytes, UPLOAD_EXPIRES),
        expiresIn: UPLOAD_EXPIRES,
      });
    },
  );

  app.post(
    "/boards/:sessionId/assets/urls",
    {
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: {
        tags: ["Boards"],
        summary: "Get short-lived links to view board files",
        description:
          "Only for admitted participants of the session, and only for files of that session's space.",
        security: [{ participantCookieAuth: [] }, { cookieAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["keys"],
          properties: { keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              urls: { type: "object", additionalProperties: { type: "string" } },
              expiresIn: { type: "integer" },
            },
            required: ["urls", "expiresIn"],
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = urlsSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ message: "Invalid request" });
      }
      const participant = await findCurrentParticipant(request, params.data.sessionId);
      if (!participant) return reply.code(401).send({ message: "Authentication required" });
      if (
        participant.sessionId !== params.data.sessionId ||
        participant.status !== "admitted" ||
        participant.session.endedAt
      ) {
        return reply.code(403).send({ message: "Access not available" });
      }
      if (!isStorageConfigured()) {
        return reply.code(503).send({ message: "File storage isn't set up yet." });
      }
      const prefix = `spaces/${participant.session.spaceId}/boards/`;
      const urls: Record<string, string> = {};
      for (const key of body.data.keys) {
        if (KEY_PATTERN.test(key) && key.startsWith(prefix)) {
          urls[key] = presignDownload(key, VIEW_EXPIRES);
        }
      }
      return reply.send({ urls, expiresIn: VIEW_EXPIRES });
    },
  );
};
