import { buildApp } from "./app.js";
import { createBoardServer } from "./modules/boards/service.js";

const app = buildApp();
createBoardServer(app);

try {
  await app.ready();
  await app.listen({
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
  });
} catch (error) {
  app.log.error({ err: error }, "Backend startup failed.");
  await app.close();
  process.exitCode = 1;
}
