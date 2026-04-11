import { logger } from "../app/logger.js";
import { loadEnv } from "../config/env.js";
import { buildServer } from "./app.js";

const env = loadEnv();
const app = await buildServer();

try {
  await app.listen({ port: env.PORT, host: env.DASHBOARD_HOST });
  logger.info(`Server listening on ${env.DASHBOARD_HOST}:${env.PORT}`);
  logger.info(
    `Dashboard available at http://${env.DASHBOARD_HOST}:${env.PORT}/`,
  );
} catch (err) {
  logger.error(err);
  process.exit(1);
}
