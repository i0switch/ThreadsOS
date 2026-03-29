import pino from "pino";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  transport:
    env.NODE_ENV !== "production" ? { target: "pino-pretty" } : undefined,
});
