import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createBoardServer } from "./modules/boards/service.js";

const app = buildApp();
const boardServer = createBoardServer(app);
let boardServerStarted = false;

try {
  await app.ready();
  await boardServer.listen(config.HOCUSPOCUS_PORT);
  boardServerStarted = true;
  await app.listen({ host: "0.0.0.0", port: 3000 });
} catch (error) {
  app.log.error({ err: error }, "Backend startup failed.");
  if (boardServerStarted) {
    await boardServer.destroy();
  }
  await app.close();
  process.exitCode = 1;
}
