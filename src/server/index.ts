import Fastify from "fastify";
import { logger } from "../app/logger.js";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

const app = Fastify({ logger: true });

app.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
}));

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`Server listening on port ${env.PORT}`);
} catch (err) {
  logger.error(err);
  process.exit(1);
}
