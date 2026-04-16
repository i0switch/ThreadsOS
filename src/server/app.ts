import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { loadEnv } from "../config/env.js";
import { dashboardRoutes } from "../dashboard/routes.js";

type BuildServerOptions = {
  dashboardToken?: string;
  logger?: boolean;
};

export async function buildServer(options: BuildServerOptions = {}) {
  const env = loadEnv();
  const dashboardToken =
    options.dashboardToken !== undefined
      ? options.dashboardToken.trim()
      : env.DASHBOARD_AUTH_TOKEN?.trim();

  const app = Fastify({ logger: options.logger ?? true });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    global: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    allowList: (request) => request.ip === "127.0.0.1" || request.ip === "::1",
  });

  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }

    // Local access (127.0.0.1 / ::1) does not require auth token
    const isLocal = request.ip === "127.0.0.1" || request.ip === "::1";
    if (isLocal && !dashboardToken) {
      return;
    }

    if (!dashboardToken) {
      reply.code(503).send({
        error: "dashboard authentication token is not configured",
      });
      return;
    }

    const bearerToken = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice("Bearer ".length)
      : null;
    const headerToken =
      typeof request.headers["x-dashboard-token"] === "string"
        ? request.headers["x-dashboard-token"]
        : null;

    if (
      isLocal ||
      bearerToken === dashboardToken ||
      headerToken === dashboardToken
    ) {
      return;
    }

    reply.code(401).send({
      error: "dashboard authentication required",
    });
  });

  const runtimeDir = fileURLToPath(new URL(".", import.meta.url));
  const dashboardPublicDir = (() => {
    const directPath = resolve(runtimeDir, "../dashboard/public");
    if (existsSync(directPath)) {
      return directPath;
    }
    return resolve(runtimeDir, "../../src/dashboard/public");
  })();

  await app.register(fastifyStatic, {
    root: dashboardPublicDir,
    prefix: "/",
    index: ["index.html"],
    decorateReply: false,
  });

  await app.register(dashboardRoutes);
  await app.ready();

  return app;
}
