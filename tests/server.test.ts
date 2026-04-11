import { beforeAll, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = ":memory:";

type BuildServer = typeof import("../src/server/app.js")["buildServer"];

let buildServer: BuildServer;

beforeAll(async () => {
  await import("../src/db/index.js");
  const { ensureAutonomyTables } = await import("../src/db/bootstrap.js");
  ({ buildServer } = await import("../src/server/app.js"));
  ensureAutonomyTables();
});

function buildApp(token?: string) {
  return buildServer({ dashboardToken: token, logger: false });
}

describe("Server", () => {
  it("GET /health returns 200 with status ok", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    await app.close();
  });

  it("serves the dashboard HTML from the production app wiring", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(
      "<title>ThreadsOS | AI運用組織ダッシュボード</title>",
    );
    await app.close();
  });

  it("protects dashboard routes when a token is configured", async () => {
    const app = await buildApp("secret-token");

    const denied = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("protects the dashboard root when a token is configured", async () => {
    const app = await buildApp("secret-token");

    const denied = await app.inject({
      method: "GET",
      url: "/",
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toContain("AI運用組織のいまがわかるダッシュボード");
    await app.close();
  });
});
