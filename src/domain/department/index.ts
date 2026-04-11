import type {
  ActionType,
  ScheduledAction,
} from "../../services/content-scheduler/index.js";

export type DepartmentName =
  | "command"
  | "external-research"
  | "competitive-analysis"
  | "threads"
  | "note";

export type DepartmentRunStatus = "completed" | "failed";

export type HeartbeatObjective =
  | "directive_assimilation"
  | "funnel_expansion"
  | "engagement_compounding";

export type FunnelStage =
  | "bootstrap"
  | "distribution"
  | "conversion"
  | "optimization";

export interface DepartmentDirective {
  department: DepartmentName;
  goal: string;
  actionTypes: ActionType[];
}

export interface DepartmentExecutionContext {
  action: ScheduledAction;
  dryRun: boolean;
  /** Executiveから部署への具体的指示（あれば） */
  instruction?: string;
}

export interface DepartmentExecutionResult {
  department: DepartmentName;
  phase: ActionType;
  status: DepartmentRunStatus;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface DepartmentReport {
  department: DepartmentName;
  /** 現在の状態サマリー（LLMが読む用） */
  summary: string;
  /** 定量データ */
  metrics: Record<string, number>;
  /** 部署側の推奨 */
  recommendation: string;
  /** 最終実行時刻 */
  lastExecutedAt: string | null;
}

export interface DepartmentExecutor {
  department: DepartmentName;
  supports(actionType: ActionType): boolean;
  execute(
    context: DepartmentExecutionContext,
  ): Promise<DepartmentExecutionResult>;
  report(): DepartmentReport;
}

export interface ResolveDepartmentNameOptions {
  channel?: "threads" | "note";
  researchMode?: "external" | "competitive" | "threads" | "note";
}

export function resolveDepartmentName(
  actionType: ActionType,
  options: ResolveDepartmentNameOptions = {},
): DepartmentName {
  switch (actionType) {
    case "process_human_inputs":
    case "notify":
      return "command";
    case "research_threads":
      if (options.researchMode === "threads") {
        return "threads";
      }
      if (options.researchMode === "competitive") {
        return "competitive-analysis";
      }
      return "external-research";
    case "research_note":
      if (options.researchMode === "competitive") {
        return "competitive-analysis";
      }
      return "note";
    case "analyze_competitors":
      return "competitive-analysis";
    case "generate_and_post":
    case "fetch_engagement":
    case "reply_safe":
    case "weekly_retro":
      return "threads";
    case "generate_note":
      return "note";
    case "optimize_schedule":
      return options.channel === "note" ? "note" : "threads";
    default:
      return "command";
  }
}
