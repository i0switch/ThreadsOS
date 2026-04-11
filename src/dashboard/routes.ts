import type { FastifyInstance } from "fastify";
import * as dq from "../services/dashboard-query/index.js";

export async function dashboardRoutes(app: FastifyInstance) {
  // ── Summary ────────────────────────────────────────────
  app.get("/api/dashboard/summary", async () => {
    return dq.getSummary();
  });

  // ── Departments ────────────────────────────────────────
  app.get("/api/dashboard/departments", async () => {
    return dq.getDepartments();
  });

  app.get<{ Params: { department: string } }>(
    "/api/dashboard/departments/:department",
    async (req) => {
      return dq.getDepartmentDetail(req.params.department);
    },
  );

  // ── Agents ─────────────────────────────────────────────
  app.get("/api/dashboard/agents", async () => {
    return dq.getAgents();
  });

  app.get<{ Params: { id: string } }>(
    "/api/dashboard/agents/:id",
    async (req, reply) => {
      const agent = dq.getAgentDetail(req.params.id);
      if (!agent) {
        reply.code(404);
        return { error: "agent not found" };
      }
      return agent;
    },
  );

  // ── Proposals ──────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>(
    "/api/dashboard/proposals",
    async (req) => {
      return dq.getProposals(req.query.status);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/dashboard/proposals/:id",
    async (req, reply) => {
      const detail = dq.getProposalDetail(req.params.id);
      if (!detail) {
        reply.code(404);
        return { error: "proposal not found" };
      }
      return detail;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/dashboard/proposals/:id/history",
    async (req, reply) => {
      const detail = dq.getProposalDetail(req.params.id);
      if (!detail) {
        reply.code(404);
        return { error: "proposal not found" };
      }
      return {
        proposalId: req.params.id,
        history: detail.history,
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/api/dashboard/proposals/:id/approve",
    async (req, reply) => {
      dq.approveProposal(req.params.id, req.body?.note);
      reply.code(200);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/api/dashboard/proposals/:id/reject",
    async (req, reply) => {
      dq.rejectProposal(req.params.id, req.body?.note);
      reply.code(200);
      return { ok: true };
    },
  );

  // ── Human Reviews ──────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>(
    "/api/dashboard/reviews",
    async (req) => {
      return dq.getReviews(req.query.status);
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/api/dashboard/reviews/:id/approve",
    async (req, reply) => {
      dq.approveReview(req.params.id, req.body?.note);
      reply.code(200);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/api/dashboard/reviews/:id/reject",
    async (req, reply) => {
      dq.rejectReview(req.params.id, req.body?.note);
      reply.code(200);
      return { ok: true };
    },
  );

  // ── Logs ───────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; perPage?: string } }>(
    "/api/dashboard/logs",
    async (req) => {
      const page = Number(req.query.page) || 1;
      const perPage = Number(req.query.perPage) || 30;
      return dq.getLogs(page, perPage);
    },
  );

  // ── Control ────────────────────────────────────────────
  app.post<{ Body: { scope?: string } }>(
    "/api/dashboard/control/pause",
    async (req, reply) => {
      const scope = req.body?.scope ?? "global";
      dq.pauseSystem(scope);
      reply.code(200);
      return { ok: true, paused: scope };
    },
  );

  app.post<{ Body: { scope?: string } }>(
    "/api/dashboard/control/resume",
    async (req, reply) => {
      const scope = req.body?.scope ?? "global";
      dq.resumeSystem(scope);
      reply.code(200);
      return { ok: true, resumed: scope };
    },
  );

  app.post<{ Params: { department: string }; Body: { note?: string } }>(
    "/api/dashboard/control/departments/:department/pause",
    async (req, reply) => {
      const note =
        req.body?.note ??
        `department pause request for ${req.params.department}`;
      dq.pauseSystem(req.params.department, note);
      reply.code(200);
      return { ok: true, paused: req.params.department, note };
    },
  );

  app.post<{ Params: { department: string }; Body: { note?: string } }>(
    "/api/dashboard/control/departments/:department/resume",
    async (req, reply) => {
      const note =
        req.body?.note ??
        `department resume request for ${req.params.department}`;
      dq.resumeSystem(req.params.department, note);
      reply.code(200);
      return { ok: true, resumed: req.params.department, note };
    },
  );

  app.post<{
    Body: {
      content: string;
      scope?: string;
      target?: string;
      department?: string;
      agentId?: string;
      priority?: string;
    };
  }>("/api/dashboard/control/directives", async (req, reply) => {
    if (!req.body?.content) {
      reply.code(400);
      return { error: "content is required" };
    }
    const id = dq.addDirective({
      content: req.body.content,
      scope: req.body.scope ?? null,
      target: req.body.target ?? null,
      department: req.body.department ?? null,
      agentId: req.body.agentId ?? null,
      priority: req.body.priority ?? null,
    });
    reply.code(201);
    return {
      ok: true,
      id,
      scope: req.body.scope ?? "global",
      target: req.body.target ?? null,
      department: req.body.department ?? null,
      agentId: req.body.agentId ?? null,
    };
  });

  // ── KPI ────────────────────────────────────────────────
  app.get("/api/dashboard/kpi", async () => {
    return dq.getKpi();
  });
}
