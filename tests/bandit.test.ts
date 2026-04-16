import { describe, expect, it } from "vitest";
import {
  laplacePosteriorMean,
  rankByThompson,
  sampleBeta,
  thompsonScore,
} from "../src/services/executive-experiment/bandit.js";

function makeSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("bandit", () => {
  it("sampleBeta returns a value in [0,1]", () => {
    const rng = makeSeededRng(42);
    for (let i = 0; i < 20; i++) {
      const v = sampleBeta(2, 5, rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("laplacePosteriorMean matches (wins+1)/(wins+losses+2)", () => {
    expect(laplacePosteriorMean(0, 0)).toBeCloseTo(0.5, 5);
    expect(laplacePosteriorMean(9, 1)).toBeCloseTo(10 / 12, 5);
    expect(laplacePosteriorMean(2, 3)).toBeCloseTo(3 / 7, 5);
  });

  it("thompsonScore returns higher mean for patterns with more wins", () => {
    const rng = makeSeededRng(1);
    const strong = thompsonScore({ wins: 20, losses: 2 }, { rng });
    const weak = thompsonScore({ wins: 1, losses: 10 }, { rng });
    expect(strong.mean).toBeGreaterThan(weak.mean);
  });

  it("rankByThompson orders items by sampled posterior", () => {
    const rng = makeSeededRng(7);
    const ranked = rankByThompson(
      [
        { patternKey: "weak", wins: 0, losses: 5 },
        { patternKey: "strong", wins: 10, losses: 1 },
        { patternKey: "neutral", wins: 2, losses: 2 },
      ],
      { rng },
    );
    expect(ranked[0].banditScore.sample).toBeGreaterThanOrEqual(
      ranked[1].banditScore.sample,
    );
    expect(ranked[1].banditScore.sample).toBeGreaterThanOrEqual(
      ranked[2].banditScore.sample,
    );
  });

  it("adds exploration boost within the exploration window", () => {
    const rng = makeSeededRng(100);
    const now = new Date("2026-04-15T00:00:00Z");
    const firstActiveAt = new Date("2026-04-14T00:00:00Z");
    const score = thompsonScore(
      { wins: 5, losses: 2 },
      { rng, now, firstActiveAt },
    );
    expect(score.explorationBoost).toBeGreaterThan(0);
    expect(score.alpha).toBeGreaterThan(6);
  });

  it("no exploration boost after the window", () => {
    const rng = makeSeededRng(200);
    const now = new Date("2026-05-15T00:00:00Z");
    const firstActiveAt = new Date("2026-04-01T00:00:00Z");
    const score = thompsonScore(
      { wins: 5, losses: 2 },
      { rng, now, firstActiveAt },
    );
    expect(score.explorationBoost).toBe(0);
    expect(score.alpha).toBe(6);
  });

  it("accumulating wins shifts selection probability toward the strong arm", () => {
    // simulate repeated selection across evolving priors
    const rng = makeSeededRng(999);
    const firstActiveAt = new Date("2026-04-15T00:00:00Z");
    const afterWindow = new Date("2026-05-15T00:00:00Z");
    let strong = { wins: 0, losses: 0 };
    const weak = { wins: 0, losses: 0 };
    let strongPicks = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      const s = thompsonScore(strong, {
        rng,
        now: afterWindow,
        firstActiveAt,
      });
      const w = thompsonScore(weak, {
        rng,
        now: afterWindow,
        firstActiveAt,
      });
      if (s.sample > w.sample) {
        strongPicks++;
        strong = { wins: strong.wins + 1, losses: strong.losses };
      } else {
        strong = { wins: strong.wins, losses: strong.losses + 1 };
      }
    }
    // After many trials, the early strong arm's prior grows and wins more often
    expect(strongPicks).toBeGreaterThan(trials * 0.3);
  });
});
