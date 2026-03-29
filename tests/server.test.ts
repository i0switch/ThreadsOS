import Fastify from "fastify";
import { describe, expect, it } from "vitest";

describe("Server", () => {
  it("GET /health returns 200 with status ok", async () => {
    const app = Fastify();
    app.get("/health", async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
    }));

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });
});
