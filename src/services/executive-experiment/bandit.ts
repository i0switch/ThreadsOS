import { loadEnv } from "../../config/env.js";

export type Rng = () => number;

export interface BanditPriorInput {
  wins: number;
  losses: number;
}

export interface BanditScore {
  mean: number;
  sample: number;
  alpha: number;
  beta: number;
  explorationBoost: number;
}

function standardNormal(rng: Rng): number {
  let u1 = rng();
  if (u1 <= Number.EPSILON) {
    u1 = Number.EPSILON;
  }
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    const boosted = sampleGamma(shape + 1, rng);
    const u = Math.max(rng(), Number.EPSILON);
    return boosted * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) {
      return d * v;
    }
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const safeAlpha = Math.max(alpha, 1e-6);
  const safeBeta = Math.max(beta, 1e-6);
  const x = sampleGamma(safeAlpha, rng);
  const y = sampleGamma(safeBeta, rng);
  if (x + y === 0) {
    return 0.5;
  }
  return x / (x + y);
}

export function laplacePosteriorMean(wins: number, losses: number): number {
  return (wins + 1) / (wins + losses + 2);
}

function explorationFactor(now: Date, firstActiveAt: Date): number {
  const env = loadEnv();
  const windowDays = env.EXPERIMENT_EXPLORATION_WINDOW_DAYS;
  if (windowDays <= 0) {
    return 0;
  }
  const elapsedDays =
    (now.getTime() - firstActiveAt.getTime()) / (24 * 60 * 60 * 1000);
  if (elapsedDays >= windowDays || elapsedDays < 0) {
    return 0;
  }
  const remaining = windowDays - elapsedDays;
  return remaining / windowDays;
}

export function thompsonScore(
  priors: BanditPriorInput,
  options: {
    rng?: Rng;
    now?: Date;
    firstActiveAt?: Date;
  } = {},
): BanditScore {
  const rng = options.rng ?? Math.random;
  const now = options.now ?? new Date();
  const firstActiveAt = options.firstActiveAt ?? now;
  const boost = explorationFactor(now, firstActiveAt);
  const alpha = priors.wins + 1;
  const beta = priors.losses + 1;
  const exploredAlpha = alpha + boost;
  const exploredBeta = beta + boost;
  const sample = sampleBeta(exploredAlpha, exploredBeta, rng);
  return {
    mean: laplacePosteriorMean(priors.wins, priors.losses),
    sample,
    alpha: exploredAlpha,
    beta: exploredBeta,
    explorationBoost: boost,
  };
}

export function rankByThompson<T extends BanditPriorInput>(
  items: T[],
  options: {
    rng?: Rng;
    now?: Date;
    firstActiveAt?: Date;
  } = {},
): Array<T & { banditScore: BanditScore }> {
  const ranked = items.map((item) => ({
    ...item,
    banditScore: thompsonScore(
      { wins: item.wins, losses: item.losses },
      options,
    ),
  }));
  ranked.sort(
    (left, right) => right.banditScore.sample - left.banditScore.sample,
  );
  return ranked;
}
