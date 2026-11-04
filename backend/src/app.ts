import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "./config.js";
import { authRoutes } from "./modules/auth/routes.js";
import { inviteRoutes } from "./modules/invites/routes.js";
import { joinRoutes } from "./modules/join/routes.js";
import { livekitRoutes } from "./modules/livekit/routes.js";
import { sessionRoutes } from "./modules/sessions/routes.js";
import { spaceRoutes } from "./modules/spaces/routes.js";
import { registerAuthDecorators } from "./plugins/auth.js";

export function buildApp() {
  const app = Fastify({ logger: true });
  registerAuthDecorators(app);

  app.register(cors, {
    origin: config.FRONTEND_ORIGIN,
    credentials: true,
  });
  app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      message: "Too many join requests. Please wait a minute and try again.",
    }),
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: "Tuteria Classroom API",
        description: "API documentation and interactive endpoint testing.",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          cookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "token",
            description: "Set automatically after a successful login.",
          },
          participantCookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "participant",
            description: "Set when joining as a guest or observer.",
          },
        },
      },
    },
  });
  app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      deepLinking: false,
      docExpansion: "list",
    },
  });

  app.register(cookie, { secret: config.JWT_SECRET });
  app.register(jwt, {
    secret: config.JWT_SECRET,
    cookie: {
      cookieName: "token",
      signed: false,
    },
  });
  app.register(authRoutes);
  app.register(spaceRoutes);
  app.register(inviteRoutes);
  app.register(joinRoutes);
  app.register(livekitRoutes);
  app.register(sessionRoutes);

  app.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        summary: "Check API health",
        response: {
          200: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
          },
        },
      },
    },
    async () => ({ status: "ok" }),
  );

  return app;
}
