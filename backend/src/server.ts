import "./config.js";
import { buildApp } from "./app.js";

const app = buildApp();

try {
  await app.listen({ host: "0.0.0.0", port: 3000 });
} catch {
  app.log.error("Server failed to start.");
  process.exitCode = 1;
}
