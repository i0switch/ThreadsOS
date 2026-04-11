import { describe, expect, it, vi } from "vitest";
import { DepartmentExecutionServiceImpl } from "../src/services/department-execution/index.js";

describe("DepartmentExecutionService", () => {
  it("routes thread generation through the threads department", async () => {
    const orchestration = {
      runDailyThreadsPlan: vi.fn(async () => "Generated 2 drafts"),
    } as const;
    const scheduler = {
      syncThreadSlotsFromAuditedDrafts: vi.fn(async () => 0),
    } as const;
    const autoPublisher = {
      publishApprovedThreadDrafts: vi.fn(async () => [
        {
          id: "post-1",
          url: "https://threads.net/post-1",
          type: "threads" as const,
        },
      ]),
    } as const;
    const runtimeState = {
      startAgent: vi.fn(),
      finishAgent: vi.fn(),
    } as const;

    const service = new DepartmentExecutionServiceImpl({
      dryRun: false,
      maxPostsPerHour: 3,
      llm: {} as never,
      storage: {} as never,
      threadsApi: { publishPost: vi.fn() } as never,
      orchestration: orchestration as never,
      scheduler: {
        ...scheduler,
      } as never,
      autoPublisher: autoPublisher as never,
      optimizer: {} as never,
      replyExecution: {} as never,
      noteEngagement: {} as never,
      notification: {} as never,
      runTrackedSubJob: vi.fn() as never,
      createNoteApiClient: vi.fn() as never,
      runtimeState: runtimeState as never,
    });

    const result = await service.execute({
      type: "generate_and_post",
      priority: 1,
      reason: "due slot",
    });

    expect(result.department).toBe("threads");
    expect(result.summary).toContain("Generated 2 drafts");
    expect(result.summary).toContain("Auto-published 1 threads posts");
    expect(orchestration.runDailyThreadsPlan).toHaveBeenCalledTimes(1);
    expect(runtimeState.startAgent).toHaveBeenCalledWith(
      "threads-post-generator",
      expect.any(String),
    );
    expect(scheduler.syncThreadSlotsFromAuditedDrafts).toHaveBeenCalledWith(3);
    expect(autoPublisher.publishApprovedThreadDrafts).toHaveBeenCalledTimes(1);
  });

  it("routes note research through the research department", async () => {
    const runTrackedSubJob = vi.fn(
      async (_jobName: string, task: () => Promise<string>) => task(),
    );
    const orchestration = {
      runNoteResearch: vi.fn(async () => "Researched note competitors"),
    } as const;
    const runtimeState = {
      startAgent: vi.fn(),
      finishAgent: vi.fn(),
    } as const;

    const service = new DepartmentExecutionServiceImpl({
      dryRun: true,
      maxPostsPerHour: 3,
      llm: {} as never,
      storage: {} as never,
      threadsApi: {} as never,
      orchestration: orchestration as never,
      scheduler: {} as never,
      autoPublisher: {} as never,
      optimizer: {} as never,
      replyExecution: {} as never,
      noteEngagement: {} as never,
      notification: {} as never,
      runTrackedSubJob: runTrackedSubJob as never,
      createNoteApiClient: vi.fn() as never,
      runtimeState: runtimeState as never,
    });

    const result = await service.execute({
      type: "research_note",
      priority: 1,
      reason: "stale research",
    });

    expect(result.department).toBe("research");
    expect(result.summary).toBe("Researched note competitors");
    expect(runtimeState.startAgent).toHaveBeenCalledWith(
      "note-competitor-researcher",
      expect.any(String),
    );
    expect(runTrackedSubJob).toHaveBeenCalledWith(
      "note-competitor-research",
      expect.any(Function),
    );
    expect(orchestration.runNoteResearch).toHaveBeenCalledTimes(1);
  });
});
