import type {
  ActionType,
  ScheduledAction,
} from "../../services/content-scheduler/index.js";

export type DepartmentName =
  | "command"
  | "research"
  | "threads"
  | "note"
  | "community"
  | "optimization";

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

export function resolveDepartmentName(actionType: ActionType): DepartmentName {
  switch (actionType) {
    case "process_human_inputs":
      return "command";
    case "research_threads":
    case "research_note":
      return "research";
    case "generate_and_post":
      return "threads";
    case "generate_note":
      return "note";
    case "reply_safe":
    case "fetch_engagement":
      return "community";
    default:
      return "optimization";
  }
}
