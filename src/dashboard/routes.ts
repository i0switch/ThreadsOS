import type { FastifyInstance } from "fastify";
import { getDashboardObservation } from "../services/dashboard-observation/index.js";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard/observation", async () => {
    return getDashboardObservation();
  });
}
