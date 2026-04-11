import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadsGraphApiClient } from "../src/adapters/threads-api/index.js";

describe("ThreadsGraphApiClient", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.THREADS_ACCESS_TOKEN = "test-token";
    process.env.THREADS_USER_ID = "test-user";
    process.env.SCRAPER_RATE_LIMIT_MS = "0";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("falls back to aliases and zeros when insight metrics are unavailable", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ name: "impressions", values: [{ value: 120 }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ name: "likes", values: [{ value: 12 }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ name: "replies", values: [{ value: 3 }] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("still failing", { status: 400 }))
      .mockResolvedValueOnce(new Response("still failing", { status: 400 }));

    global.fetch = fetchMock;

    const client = new ThreadsGraphApiClient();
    const insights = await client.getInsights("post-1");

    expect(insights).toEqual({
      impressions: 120,
      likes: 12,
      replies: 3,
      shares: 0,
      views: 120,
    });
    expect(fetchMock).toHaveBeenCalled();
    const [requestedUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestedUrl).toBe(
      "https://graph.threads.net/v1.0/post-1/insights?metric=views&metric=likes&metric=replies&metric=shares",
    );
    expect(requestInit?.headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
  });
});
