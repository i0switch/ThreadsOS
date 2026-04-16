import { randomUUID } from "node:crypto";
import { and, eq, gte, lt, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { createRuntimeLedgerRepository } from "../../db/repositories/runtime-ledger.js";
import {
  experimentResults,
  experiments,
  losingPatterns,
  notePostResults,
  threadPostResults,
  winningPatterns,
} from "../../db/schema.js";
import type {
  DepartmentExperimentContext,
  FunnelBottleneck,
} from "../../domain/department/index.js";
import type {
  ActionType,
  ScheduledAction,
} from "../content-scheduler/index.js";
import { laplacePosteriorMean, thompsonScore } from "./bandit.js";

export interface AggregateMetrics {
  threadCount: number;
  noteCount: number;
  impressions: number;
  threadEngagements: number;
  noteViews: number;
  noteEngagements: number;
  purchases: number;
  revenue: number;
  avgImpressionsPerPost: number;
  transitionIntentRate: number;
  noteViewRate: number;
  readEngagementRate: number;
  purchaseRate: number;
  revenuePerView: number;
}

export interface BottleneckDiagnosis {
  snapshotId: string;
  bottleneck: FunnelBottleneck;
  confidence: "low" | "medium" | "high";
  current: AggregateMetrics;
  baseline: AggregateMetrics;
  healthScores: Record<FunnelBottleneck, number | null>;
  primaryMetric: string;
  reasons: string[];
  proxyNotes: string[];
}

export interface ExperimentCandidate {
  patternKey: string;
  actionType: ActionType;
  channel: "threads" | "note";
  primaryMetric: string;
  hypothesis: string;
  guidance: string;
  angleId?: string;
  ctaId?: string;
  sampleSize: number;
  priorWins: number;
  priorLosses: number;
  banditPrior: number;
  available: boolean;
}

export interface PlannedExperiment {
  experimentId: string;
  diagnosis: BottleneckDiagnosis;
  candidates: ExperimentCandidate[];
  selected: ExperimentCandidate;
  executionContext: DepartmentExperimentContext;
}

export interface EvaluationSummary {
  evaluatedCount: number;
  promotedCount: number;
  rejectedCount: number;
  summaries: string[];
}

interface CandidateTemplate {
  patternKey: string;
  hypothesis: string;
  guidance: string;
  angleId?: string;
  ctaId?: string;
}

interface ExperimentEvaluationDecision {
  final: boolean;
  outcome: "hold" | "promote" | "reject" | "insufficient_data";
  reason: string;
  observedValue: number;
  baselineValue: number;
}

const CONTENT_ACTION_TYPES: ActionType[] = [
  "generate_and_post",
  "generate_note",
];

const CANDIDATE_LIBRARY: Record<FunnelBottleneck, CandidateTemplate[]> = {
  Reach: [
    {
      patternKey: "reach-hook-reset",
      angleId: "reach-hook-reset",
      hypothesis: "トップ1行を価値直結へ寄せると初速の表示量が伸びる",
      guidance:
        "冒頭1行を結論先出しにし、保存したくなる具体的ベネフィットを先頭へ置く。",
    },
    {
      patternKey: "reach-story-contrast",
      angleId: "reach-story-contrast",
      hypothesis: "短い失敗談から入ると表示継続とシェアが伸びる",
      guidance:
        "抽象論ではなく、1つの失敗例から逆説的な学びへつなげる構成にする。",
    },
    {
      patternKey: "reach-contrarian-hook",
      angleId: "reach-contrarian-hook",
      hypothesis: "常識反転フックは表示面での差分を作りやすい",
      guidance:
        "一般論を1つだけ反転し、根拠をすぐ続けて炎上しない形でコントラストを出す。",
    },
  ],
  Click: [
    {
      patternKey: "click-note-bridge",
      ctaId: "click-note-bridge",
      hypothesis: "Threads本文とnote導線の約束を明確にすると遷移意図が上がる",
      guidance:
        "本文内で note で得られる続きを1つだけ明示し、CTA は最後に1回だけ置く。",
    },
    {
      patternKey: "click-single-cta",
      ctaId: "click-single-cta",
      hypothesis: "CTA を1つに絞ると遷移率が改善する",
      guidance:
        "保存・コメントなど複数CTAを混ぜず、noteへの導線だけに集中する。",
    },
    {
      patternKey: "click-promise-specificity",
      ctaId: "click-promise-specificity",
      hypothesis: "遷移後に何が読めるかを具体化するとクリック意図が上がる",
      guidance:
        "note遷移文は曖昧な案内を避け、読後に得られる具体例やテンプレを約束する。",
    },
  ],
  Read: [
    {
      patternKey: "read-title-lead-tighten",
      angleId: "read-title-lead-tighten",
      hypothesis: "タイトルと導入のズレを減らすと読了意欲が上がる",
      guidance:
        "タイトルの約束を導入の最初の2段落で回収し、余白説明を削って本題に早く入る。",
    },
    {
      patternKey: "read-outline-compression",
      angleId: "read-outline-compression",
      hypothesis: "見出し数を絞ると離脱が減る",
      guidance: "H2/H3を増やしすぎず、各見出しの目的を明確にして寄り道を削る。",
    },
    {
      patternKey: "read-reader-specificity",
      angleId: "read-reader-specificity",
      hypothesis: "想定読者を狭めると本文の保持率が上がる",
      guidance:
        "読者像を1つに絞り、例や悩みもその読者が自分ごと化できるものに限定する。",
    },
  ],
  Buy: [
    {
      patternKey: "buy-offer-clarity",
      ctaId: "buy-offer-clarity",
      hypothesis: "有料部分の価値を明確化すると購入率が改善する",
      guidance:
        "有料パートで解決する内容を具体化し、無料パートでは問題設定までで止める。",
    },
    {
      patternKey: "buy-proof-cta",
      ctaId: "buy-proof-cta",
      hypothesis: "結果や根拠をCTA直前に置くと購入意思決定がしやすい",
      guidance:
        "CTA直前に実績・再現条件・向いている読者を短く並べて不安を減らす。",
    },
    {
      patternKey: "buy-paywall-preview",
      ctaId: "buy-paywall-preview",
      hypothesis: "有料境界直前の予告を改善するとCVが上がる",
      guidance:
        "有料導入直前で得られるテンプレや判断基準を1つだけ予告し、価格の妥当性を伝える。",
    },
  ],
};

function nowIso(date = new Date()): string {
  return date.toISOString();
}

function hoursFrom(base: Date, hours: number): string {
  return new Date(base.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function hoursAgo(base: Date, hours: number): string {
  return new Date(base.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function safeDivide(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return value / total;
}


function toAggregateMetrics(params: {
  threadRows: Array<typeof threadPostResults.$inferSelect>;
  noteRows: Array<typeof notePostResults.$inferSelect>;
}): AggregateMetrics {
  const impressions = params.threadRows.reduce(
    (sum, row) => sum + row.impressions,
    0,
  );
  const threadEngagements = params.threadRows.reduce(
    (sum, row) => sum + row.likes + row.repliesCount + row.shares,
    0,
  );
  const noteViews = params.noteRows.reduce((sum, row) => sum + row.views, 0);
  const noteEngagements = params.noteRows.reduce(
    (sum, row) => sum + row.likes + row.commentsCount,
    0,
  );
  const purchases = params.noteRows.reduce(
    (sum, row) => sum + row.purchasesCount,
    0,
  );
  const revenue = params.noteRows.reduce((sum, row) => sum + row.revenueYen, 0);

  return {
    threadCount: params.threadRows.length,
    noteCount: params.noteRows.length,
    impressions,
    threadEngagements,
    noteViews,
    noteEngagements,
    purchases,
    revenue,
    avgImpressionsPerPost: safeDivide(impressions, params.threadRows.length),
    transitionIntentRate: safeDivide(threadEngagements, impressions),
    noteViewRate: safeDivide(noteViews, impressions),
    readEngagementRate: safeDivide(noteEngagements, noteViews),
    purchaseRate: safeDivide(purchases, noteViews),
    revenuePerView: safeDivide(revenue, noteViews),
  };
}

function metricValue(metrics: AggregateMetrics, metricName: string): number {
  switch (metricName) {
    case "avg_impressions_per_post":
      return metrics.avgImpressionsPerPost;
    case "transition_intent_rate":
      return metrics.transitionIntentRate;
    case "note_view_rate":
      return metrics.noteViewRate;
    case "read_engagement_rate":
      return metrics.readEngagementRate;
    case "purchase_rate":
      return metrics.purchaseRate;
    case "revenue_per_view":
      return metrics.revenuePerView;
    default:
      return 0;
  }
}

function healthScore(current: number, baseline: number): number | null {
  if (current <= 0 && baseline <= 0) {
    return null;
  }
  if (baseline <= 0) {
    return current > 0 ? 1 : 0;
  }
  return current / baseline;
}

function preferredActionTypes(bottleneck: FunnelBottleneck): ActionType[] {
  switch (bottleneck) {
    case "Reach":
    case "Click":
      return ["generate_and_post", "generate_note"];
    case "Read":
    case "Buy":
      return ["generate_note", "generate_and_post"];
  }
}

function detectConfidence(
  diagnosis: BottleneckDiagnosis,
): "low" | "medium" | "high" {
  const { current, bottleneck } = diagnosis;
  if (bottleneck === "Reach" || bottleneck === "Click") {
    if (current.threadCount >= 2 && current.impressions > 0) {
      return "high";
    }
    return current.threadCount > 0 ? "medium" : "low";
  }
  if (current.noteCount >= 2 && current.noteViews > 0) {
    return "high";
  }
  return current.noteCount > 0 ? "medium" : "low";
}

export interface ExecutiveExperimentService {
  planHeartbeatExperiment(input: {
    cycleId: string;
    heartbeatPeriodKey: string;
    candidateActions: ScheduledAction[];
    approvedActions: ScheduledAction[];
    objective?: string;
    funnelStage?: string;
    llmReasoning?: string;
    now?: Date;
  }): PlannedExperiment | null;
  markCanaryLaunched(input: {
    experimentId: string;
    publishedCount: number;
    launchedAt?: string;
  }): void;
  evaluateDueExperiments(now?: Date): EvaluationSummary;
}

export class ExecutiveExperimentServiceImpl
  implements ExecutiveExperimentService
{
  private readonly ledger = createRuntimeLedgerRepository();
  private readonly rng: () => number;
  private readonly firstActiveAt: Date;

  constructor(options: { rng?: () => number; firstActiveAt?: Date } = {}) {
    this.rng = options.rng ?? Math.random;
    this.firstActiveAt = options.firstActiveAt ?? this.resolveFirstActiveAt();
  }

  private resolveFirstActiveAt(): Date {
    const earliest = db
      .select()
      .from(experiments)
      .orderBy(experiments.createdAt)
      .limit(1)
      .get();
    if (earliest?.createdAt) {
      const parsed = new Date(earliest.createdAt);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return new Date();
  }

  private listThreadRows(
    startIso: string,
    endIso: string,
    campaignId?: string,
  ) {
    if (campaignId) {
      return db
        .select()
        .from(threadPostResults)
        .where(
          and(
            eq(threadPostResults.campaignId, campaignId),
            gte(threadPostResults.publishedAt, startIso),
            lt(threadPostResults.publishedAt, endIso),
          ),
        )
        .all();
    }

    return db
      .select()
      .from(threadPostResults)
      .where(
        and(
          gte(threadPostResults.publishedAt, startIso),
          lt(threadPostResults.publishedAt, endIso),
        ),
      )
      .all();
  }

  private listNoteRows(startIso: string, endIso: string, campaignId?: string) {
    if (campaignId) {
      return db
        .select()
        .from(notePostResults)
        .where(
          and(
            eq(notePostResults.campaignId, campaignId),
            gte(notePostResults.publishedAt, startIso),
            lt(notePostResults.publishedAt, endIso),
          ),
        )
        .all();
    }

    return db
      .select()
      .from(notePostResults)
      .where(
        and(
          gte(notePostResults.publishedAt, startIso),
          lt(notePostResults.publishedAt, endIso),
        ),
      )
      .all();
  }

  private aggregateWindow(
    startIso: string,
    endIso: string,
    campaignId?: string,
  ) {
    return toAggregateMetrics({
      threadRows: this.listThreadRows(startIso, endIso, campaignId),
      noteRows: this.listNoteRows(startIso, endIso, campaignId),
    });
  }

  private resolvePrimaryMetric(
    bottleneck: FunnelBottleneck,
    metrics: AggregateMetrics,
    baseline: AggregateMetrics,
  ): string {
    switch (bottleneck) {
      case "Reach":
        return "avg_impressions_per_post";
      case "Click":
        return metrics.noteViews > 0 || baseline.noteViews > 0
          ? "note_view_rate"
          : "transition_intent_rate";
      case "Read":
        return "read_engagement_rate";
      case "Buy":
        return metrics.revenue > 0 || baseline.revenue > 0
          ? "revenue_per_view"
          : "purchase_rate";
    }
  }

  private diagnose(now: Date): BottleneckDiagnosis {
    const currentStart = hoursAgo(now, 72);
    const currentEnd = nowIso(now);
    const baselineStart = hoursAgo(now, 72 * 4);
    const baselineEnd = currentStart;
    const current = this.aggregateWindow(currentStart, currentEnd);
    const baseline = this.aggregateWindow(baselineStart, baselineEnd);

    const proxyNotes = [
      "profile_transitions は Threads の engagement 合計を proxy として扱う",
      "note_clicks は note views を conservative proxy として扱う",
    ];

    let bottleneck: FunnelBottleneck = "Reach";
    const reasons: string[] = [];

    if (current.threadCount === 0 || current.impressions === 0) {
      bottleneck = "Reach";
      reasons.push("直近72時間の上流表示が不足しているため Reach を優先する");
    } else if (current.noteViews === 0) {
      bottleneck = "Click";
      reasons.push("表示はあるが note 流入がゼロのため Click を優先する");
    } else if (current.noteEngagements === 0) {
      bottleneck = "Read";
      reasons.push(
        "note 閲覧はあるが読了・反応 proxy が弱いため Read を優先する",
      );
    } else if (current.purchases === 0 && current.noteViews > 0) {
      bottleneck = "Buy";
      reasons.push("閲覧はあるが購入がゼロのため Buy を優先する");
    } else {
      const scores: Record<FunnelBottleneck, number | null> = {
        Reach: healthScore(
          current.avgImpressionsPerPost,
          baseline.avgImpressionsPerPost,
        ),
        Click: healthScore(
          current.noteViews > 0 || baseline.noteViews > 0
            ? current.noteViewRate
            : current.transitionIntentRate,
          current.noteViews > 0 || baseline.noteViews > 0
            ? baseline.noteViewRate
            : baseline.transitionIntentRate,
        ),
        Read: healthScore(
          current.readEngagementRate,
          baseline.readEngagementRate,
        ),
        Buy: healthScore(
          current.revenue > 0 || baseline.revenue > 0
            ? current.revenuePerView
            : current.purchaseRate,
          current.revenue > 0 || baseline.revenue > 0
            ? baseline.revenuePerView
            : baseline.purchaseRate,
        ),
      };

      const ordered = Object.entries(scores)
        .filter(
          (entry): entry is [FunnelBottleneck, number] => entry[1] !== null,
        )
        .sort((left, right) => left[1] - right[1]);

      if (ordered.length > 0) {
        bottleneck = ordered[0][0];
        reasons.push(
          `${ordered[0][0]} の health score が最小 (${ordered[0][1].toFixed(3)}) のため優先する`,
        );
      }
    }

    const primaryMetric = this.resolvePrimaryMetric(
      bottleneck,
      current,
      baseline,
    );
    const snapshotId = this.ledger.upsertFunnelSnapshot({
      periodKey: nowIso(now).slice(0, 13),
      periodType: "hourly",
      impressions: current.impressions,
      profileTransitions: current.threadEngagements,
      noteClicks: current.noteViews,
      noteViews: current.noteViews,
      purchases: current.purchases,
      revenue: current.revenue,
      capturedAt: nowIso(now),
    });

    const diagnosis: BottleneckDiagnosis = {
      snapshotId,
      bottleneck,
      confidence: "low",
      current,
      baseline,
      healthScores: {
        Reach: healthScore(
          current.avgImpressionsPerPost,
          baseline.avgImpressionsPerPost,
        ),
        Click: healthScore(
          current.noteViews > 0 || baseline.noteViews > 0
            ? current.noteViewRate
            : current.transitionIntentRate,
          current.noteViews > 0 || baseline.noteViews > 0
            ? baseline.noteViewRate
            : baseline.transitionIntentRate,
        ),
        Read: healthScore(
          current.readEngagementRate,
          baseline.readEngagementRate,
        ),
        Buy: healthScore(
          current.revenue > 0 || baseline.revenue > 0
            ? current.revenuePerView
            : current.purchaseRate,
          current.revenue > 0 || baseline.revenue > 0
            ? baseline.revenuePerView
            : baseline.purchaseRate,
        ),
      },
      primaryMetric,
      reasons,
      proxyNotes,
    };
    diagnosis.confidence = detectConfidence(diagnosis);
    return diagnosis;
  }

  private countPatternWins(patternKey: string): number {
    return db
      .select()
      .from(winningPatterns)
      .where(eq(winningPatterns.patternKey, patternKey))
      .all().length;
  }

  private countPatternLosses(patternKey: string): number {
    return db
      .select()
      .from(losingPatterns)
      .where(eq(losingPatterns.patternKey, patternKey))
      .all().length;
  }

  private buildCandidates(
    diagnosis: BottleneckDiagnosis,
    availableActions: ActionType[],
  ): ExperimentCandidate[] {
    const availableActionSet = new Set(availableActions);
    const selectedActionType =
      preferredActionTypes(diagnosis.bottleneck).find((type) =>
        availableActionSet.has(type),
      ) ??
      CONTENT_ACTION_TYPES.find((type) => availableActionSet.has(type)) ??
      availableActions[0] ??
      "generate_and_post";
    const channel: ExperimentCandidate["channel"] =
      selectedActionType === "generate_note" ? "note" : "threads";
    const sampleSize = selectedActionType === "generate_note" ? 1 : 2;

    const scoredCandidates = CANDIDATE_LIBRARY[diagnosis.bottleneck]
      .slice(0, 3)
      .map((template) => {
        const priorWins = this.countPatternWins(template.patternKey);
        const priorLosses = this.countPatternLosses(template.patternKey);
        const banditScore = thompsonScore(
          { wins: priorWins, losses: priorLosses },
          {
            rng: this.rng,
            now: new Date(),
            firstActiveAt: this.firstActiveAt,
          },
        );
        const candidate: ExperimentCandidate = {
          patternKey: template.patternKey,
          actionType: selectedActionType,
          channel,
          primaryMetric: diagnosis.primaryMetric,
          hypothesis: template.hypothesis,
          guidance: template.guidance,
          angleId: template.angleId,
          ctaId: template.ctaId,
          sampleSize,
          priorWins,
          priorLosses,
          banditPrior: laplacePosteriorMean(priorWins, priorLosses),
          available: availableActionSet.has(selectedActionType),
        };
        return { candidate, banditSample: banditScore.sample };
      });
    scoredCandidates.sort((left, right) => {
      if (
        Number(right.candidate.available) !== Number(left.candidate.available)
      ) {
        return (
          Number(right.candidate.available) - Number(left.candidate.available)
        );
      }
      if (right.banditSample !== left.banditSample) {
        return right.banditSample - left.banditSample;
      }
      return left.candidate.patternKey.localeCompare(right.candidate.patternKey);
    });
    return scoredCandidates.map((entry) => entry.candidate);
  }

  planHeartbeatExperiment(input: {
    cycleId: string;
    heartbeatPeriodKey: string;
    candidateActions: ScheduledAction[];
    approvedActions: ScheduledAction[];
    objective?: string;
    funnelStage?: string;
    llmReasoning?: string;
    now?: Date;
  }): PlannedExperiment | null {
    const now = input.now ?? new Date();
    const diagnosis = this.diagnose(now);
    const candidateActionTypes = [
      ...input.approvedActions.map((action) => action.type),
      ...input.candidateActions.map((action) => action.type),
    ];
    const candidates = this.buildCandidates(diagnosis, candidateActionTypes);
    const selected = candidates[0];

    if (!selected) {
      return null;
    }

    const experimentId = randomUUID();
    const createdAt = nowIso(now);
    db.insert(experiments)
      .values({
        id: experimentId,
        cycleId: input.cycleId,
        status: "planned",
        bottleneck: diagnosis.bottleneck,
        actionType: selected.actionType,
        channel: selected.channel,
        patternKey: selected.patternKey,
        primaryMetric: selected.primaryMetric,
        hypothesis: selected.hypothesis,
        guidance: selected.guidance,
        sampleSize: selected.sampleSize,
        canaryGroup: "canary",
        angleId: selected.angleId ?? null,
        ctaId: selected.ctaId ?? null,
        baselineJson: JSON.stringify(diagnosis.baseline),
        diagnosisJson: JSON.stringify(diagnosis),
        selectionJson: JSON.stringify({
          heartbeatPeriodKey: input.heartbeatPeriodKey,
          objective: input.objective ?? null,
          funnelStage: input.funnelStage ?? null,
          llmReasoning: input.llmReasoning ?? null,
          candidates,
          selected,
        }),
        launchedAt: null,
        promotedAt: null,
        rejectedAt: null,
        createdAt,
        updatedAt: createdAt,
      })
      .run();

    for (const windowHours of [24, 72]) {
      db.insert(experimentResults)
        .values({
          id: randomUUID(),
          experimentId,
          windowHours,
          status: "pending",
          scheduledFor: hoursFrom(now, windowHours),
          measuredAt: null,
          outcome: null,
          metricsJson: null,
          note: null,
          createdAt,
          updatedAt: createdAt,
        })
        .run();
    }

    this.ledger.recordDecisionEvidence({
      entityType: "experiment",
      entityId: experimentId,
      decisionType: "selected",
      evidence: {
        cycleId: input.cycleId,
        heartbeatPeriodKey: input.heartbeatPeriodKey,
        diagnosis,
        candidates,
        selected,
      },
    });

    return {
      experimentId,
      diagnosis,
      candidates,
      selected,
      executionContext: {
        experimentId,
        bottleneck: diagnosis.bottleneck,
        actionType: selected.actionType,
        campaignId: experimentId,
        canaryGroup: "canary",
        sampleSize: selected.sampleSize,
        primaryMetric: selected.primaryMetric,
        guidance: selected.guidance,
        hypothesis: selected.hypothesis,
        angleId: selected.angleId,
        ctaId: selected.ctaId,
      },
    };
  }

  markCanaryLaunched(input: {
    experimentId: string;
    publishedCount: number;
    launchedAt?: string;
  }): void {
    const experiment = db
      .select()
      .from(experiments)
      .where(eq(experiments.id, input.experimentId))
      .get();

    if (!experiment) {
      return;
    }

    const launchedAt = input.launchedAt ?? nowIso();
    const nextStatus =
      input.publishedCount > 0 ? "canary_live" : "not_launched";
    db.update(experiments)
      .set({
        status: nextStatus,
        launchedAt:
          input.publishedCount > 0 ? launchedAt : experiment.launchedAt,
        updatedAt: nowIso(),
      })
      .where(eq(experiments.id, experiment.id))
      .run();

    if (input.publishedCount > 0) {
      for (const windowHours of [24, 72]) {
        db.update(experimentResults)
          .set({
            scheduledFor: hoursFrom(new Date(launchedAt), windowHours),
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(experimentResults.experimentId, experiment.id),
              eq(experimentResults.windowHours, windowHours),
            ),
          )
          .run();
      }
    } else {
      db.update(experimentResults)
        .set({
          status: "cancelled",
          outcome: "not_launched",
          note: "Selected action did not publish a canary payload",
          updatedAt: nowIso(),
        })
        .where(eq(experimentResults.experimentId, experiment.id))
        .run();
    }

    this.ledger.recordDecisionEvidence({
      entityType: "experiment",
      entityId: experiment.id,
      decisionType:
        input.publishedCount > 0 ? "canary_launched" : "canary_not_launched",
      evidence: {
        experimentId: experiment.id,
        launchedAt,
        publishedCount: input.publishedCount,
      },
    });
  }

  private evaluateOutcome(input: {
    experiment: typeof experiments.$inferSelect;
    resultRow: typeof experimentResults.$inferSelect;
    observed: AggregateMetrics;
    baseline: AggregateMetrics;
  }): ExperimentEvaluationDecision {
    const baselineValue = metricValue(
      input.baseline,
      input.experiment.primaryMetric,
    );
    const observedValue = metricValue(
      input.observed,
      input.experiment.primaryMetric,
    );
    const sampleCount =
      input.experiment.actionType === "generate_note"
        ? input.observed.noteCount
        : input.observed.threadCount;
    const revenueComparable =
      input.baseline.revenuePerView > 0 || input.observed.revenue > 0;
    const purchaseComparable =
      input.baseline.purchaseRate > 0 || input.observed.purchases > 0;
    const primaryImproved = observedValue >= baselineValue;

    if (sampleCount === 0) {
      return input.resultRow.windowHours >= 72
        ? {
            final: true,
            outcome: "reject",
            reason: "canary publish が観測されなかったため保守的に reject する",
            observedValue,
            baselineValue,
          }
        : {
            final: false,
            outcome: "insufficient_data",
            reason: "24h 時点では十分な canary データがない",
            observedValue,
            baselineValue,
          };
    }

    if (input.resultRow.windowHours === 24) {
      if (
        revenueComparable &&
        input.observed.revenuePerView < input.baseline.revenuePerView
      ) {
        return {
          final: true,
          outcome: "reject",
          reason:
            "24h で revenue/view が baseline を下回ったため early reject する",
          observedValue,
          baselineValue,
        };
      }

      if (
        !revenueComparable &&
        purchaseComparable &&
        input.observed.purchaseRate < input.baseline.purchaseRate &&
        !primaryImproved
      ) {
        return {
          final: true,
          outcome: "reject",
          reason:
            "24h で purchase proxy も primary proxy も改善せず early reject する",
          observedValue,
          baselineValue,
        };
      }

      return {
        final: false,
        outcome: primaryImproved ? "hold" : "insufficient_data",
        reason: primaryImproved
          ? "24h では primary proxy は改善しているが、72h で最終判定する"
          : "24h では proxy 改善が不十分なので 72h を待つ",
        observedValue,
        baselineValue,
      };
    }

    if (revenueComparable) {
      return input.observed.revenuePerView >= input.baseline.revenuePerView &&
        primaryImproved
        ? {
            final: true,
            outcome: "promote",
            reason:
              "72h で revenue/view と primary proxy がともに baseline 以上のため promote する",
            observedValue,
            baselineValue,
          }
        : {
            final: true,
            outcome: "reject",
            reason:
              "72h で revenue/view か primary proxy が baseline を超えなかったため reject する",
            observedValue,
            baselineValue,
          };
    }

    if (purchaseComparable) {
      return input.observed.purchaseRate >= input.baseline.purchaseRate &&
        primaryImproved
        ? {
            final: true,
            outcome: "promote",
            reason:
              "72h で purchase proxy と primary proxy が baseline 以上のため promote する",
            observedValue,
            baselineValue,
          }
        : {
            final: true,
            outcome: "reject",
            reason:
              "72h で purchase proxy も primary proxy も baseline を超えなかったため reject する",
            observedValue,
            baselineValue,
          };
    }

    return primaryImproved
      ? {
          final: true,
          outcome: "promote",
          reason:
            "72h で primary proxy が baseline を上回ったため promote する",
          observedValue,
          baselineValue,
        }
      : {
          final: true,
          outcome: "reject",
          reason:
            "72h で primary proxy が baseline を上回らなかったため reject する",
          observedValue,
          baselineValue,
        };
  }

  private finalizeExperiment(input: {
    experiment: typeof experiments.$inferSelect;
    decision: ExperimentEvaluationDecision;
    resultRow: typeof experimentResults.$inferSelect;
    observed: AggregateMetrics;
    measuredAt: string;
  }) {
    const targetTable =
      input.decision.outcome === "promote" ? winningPatterns : losingPatterns;
    db.insert(targetTable)
      .values({
        id: randomUUID(),
        experimentId: input.experiment.id,
        patternKey: input.experiment.patternKey,
        bottleneck: input.experiment.bottleneck,
        actionType: input.experiment.actionType,
        primaryMetric: input.experiment.primaryMetric,
        baselineValue: input.decision.baselineValue,
        observedValue: input.decision.observedValue,
        evidenceJson: JSON.stringify({
          windowHours: input.resultRow.windowHours,
          reason: input.decision.reason,
          observed: input.observed,
        }),
        createdAt: input.measuredAt,
      })
      .run();

    db.update(experiments)
      .set({
        status: input.decision.outcome === "promote" ? "promoted" : "rejected",
        promotedAt:
          input.decision.outcome === "promote"
            ? input.measuredAt
            : input.experiment.promotedAt,
        rejectedAt:
          input.decision.outcome === "reject"
            ? input.measuredAt
            : input.experiment.rejectedAt,
        updatedAt: input.measuredAt,
      })
      .where(eq(experiments.id, input.experiment.id))
      .run();

    db.update(experimentResults)
      .set({
        status: "cancelled",
        outcome: "cancelled",
        note: `Finalized by ${input.resultRow.windowHours}h evaluation`,
        updatedAt: input.measuredAt,
      })
      .where(
        and(
          eq(experimentResults.experimentId, input.experiment.id),
          eq(experimentResults.status, "pending"),
        ),
      )
      .run();
  }

  evaluateDueExperiments(now = new Date()): EvaluationSummary {
    const dueRows = db
      .select()
      .from(experimentResults)
      .where(
        and(
          eq(experimentResults.status, "pending"),
          lte(experimentResults.scheduledFor, nowIso(now)),
        ),
      )
      .all();
    const summaries: string[] = [];
    let promotedCount = 0;
    let rejectedCount = 0;

    for (const resultRow of dueRows) {
      const experiment = db
        .select()
        .from(experiments)
        .where(eq(experiments.id, resultRow.experimentId))
        .get();
      if (!experiment?.launchedAt) {
        continue;
      }

      let baseline: AggregateMetrics;
      try {
        baseline = JSON.parse(experiment.baselineJson) as AggregateMetrics;
      } catch {
        baseline = toAggregateMetrics({ threadRows: [], noteRows: [] });
      }

      const measuredAt = nowIso(now);
      const observed = this.aggregateWindow(
        experiment.launchedAt,
        measuredAt,
        experiment.id,
      );
      const decision = this.evaluateOutcome({
        experiment,
        resultRow,
        observed,
        baseline,
      });

      db.update(experimentResults)
        .set({
          status: decision.final ? "measured" : "awaiting_final",
          measuredAt,
          outcome: decision.outcome,
          metricsJson: JSON.stringify(observed),
          note: decision.reason,
          updatedAt: measuredAt,
        })
        .where(eq(experimentResults.id, resultRow.id))
        .run();

      this.ledger.recordDecisionEvidence({
        entityType: "experiment",
        entityId: experiment.id,
        decisionType: `evaluate_${resultRow.windowHours}h`,
        evidence: {
          outcome: decision.outcome,
          reason: decision.reason,
          observed,
          baseline,
          windowHours: resultRow.windowHours,
        },
      });

      if (
        decision.final &&
        (decision.outcome === "promote" || decision.outcome === "reject")
      ) {
        this.finalizeExperiment({
          experiment,
          decision,
          resultRow,
          observed,
          measuredAt,
        });
        if (decision.outcome === "promote") {
          promotedCount += 1;
        } else {
          rejectedCount += 1;
        }
      } else {
        db.update(experiments)
          .set({
            status: "awaiting_72h",
            updatedAt: measuredAt,
          })
          .where(eq(experiments.id, experiment.id))
          .run();
      }

      summaries.push(
        `${experiment.id}:${resultRow.windowHours}h:${decision.outcome}:${decision.reason}`,
      );
    }

    return {
      evaluatedCount: dueRows.length,
      promotedCount,
      rejectedCount,
      summaries,
    };
  }
}
