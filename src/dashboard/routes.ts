import type { FastifyInstance } from "fastify";
import {
  getDashboardObservation,
  getDashboardMission,
  getDashboardRevenue,
  getDashboardExecutive,
  getDashboardDepartments,
  getDashboardExperiments,
  getDashboardSystem,
} from "../services/dashboard-observation/index.js";

export async function dashboardRoutes(app: FastifyInstance) {
  // Legacy (既存互換)
  app.get("/api/dashboard/observation", async () => {
    return getDashboardObservation();
  });

  // 新API: 司令室用6分割
  app.get("/api/dashboard/mission", async () => {
    return getDashboardMission();
  });

  app.get("/api/dashboard/revenue", async () => {
    return getDashboardRevenue();
  });

  app.get("/api/dashboard/executive", async () => {
    return getDashboardExecutive();
  });

  app.get("/api/dashboard/departments", async () => {
    return getDashboardDepartments();
  });

  app.get("/api/dashboard/experiments", async () => {
    return getDashboardExperiments();
  });

  app.get("/api/dashboard/system", async () => {
    return getDashboardSystem();
  });
}
