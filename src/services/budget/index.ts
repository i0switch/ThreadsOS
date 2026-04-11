import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { budgetTracking } from "../../db/schema.js";

export interface BudgetService {
  canSpend(scope: string, tokens: number, calls: number): boolean;
  spend(scope: string, tokens: number, calls: number): void;
  getRemainingBudget(scope: string): { tokens: number; calls: number };
  resetPeriod(scope: string, period: string): void;
  initBudget(
    scope: string,
    period: string,
    periodKey: string,
    tokensLimit: number,
    callsLimit: number,
  ): void;
}

function getLatestBudget(scope: string) {
  return db
    .select()
    .from(budgetTracking)
    .where(eq(budgetTracking.scope, scope))
    .orderBy(desc(budgetTracking.updatedAt), desc(budgetTracking.createdAt))
    .get();
}

export function createBudgetService(): BudgetService {
  function canSpend(scope: string, tokens: number, calls: number): boolean {
    const budget = getLatestBudget(scope);
    if (!budget) return false;
    return (
      budget.tokensUsed + tokens <= budget.tokensLimit &&
      budget.callsUsed + calls <= budget.callsLimit
    );
  }

  function spend(scope: string, tokens: number, calls: number): void {
    const budget = getLatestBudget(scope);
    if (!budget) {
      throw new Error(`No budget found for scope: ${scope}`);
    }
    const now = new Date().toISOString();
    db.update(budgetTracking)
      .set({
        tokensUsed: budget.tokensUsed + tokens,
        callsUsed: budget.callsUsed + calls,
        updatedAt: now,
      })
      .where(eq(budgetTracking.id, budget.id))
      .run();
  }

  function getRemainingBudget(scope: string): {
    tokens: number;
    calls: number;
  } {
    const budget = getLatestBudget(scope);
    if (!budget) return { tokens: 0, calls: 0 };
    return {
      tokens: budget.tokensLimit - budget.tokensUsed,
      calls: budget.callsLimit - budget.callsUsed,
    };
  }

  function resetPeriod(scope: string, period: string): void {
    const now = new Date().toISOString();
    const rows = db
      .select()
      .from(budgetTracking)
      .where(
        and(eq(budgetTracking.scope, scope), eq(budgetTracking.period, period)),
      )
      .all();
    for (const row of rows) {
      db.update(budgetTracking)
        .set({ tokensUsed: 0, callsUsed: 0, updatedAt: now })
        .where(eq(budgetTracking.id, row.id))
        .run();
    }
  }

  function initBudget(
    scope: string,
    period: string,
    periodKey: string,
    tokensLimit: number,
    callsLimit: number,
  ): void {
    const now = new Date().toISOString();
    db.insert(budgetTracking)
      .values({
        id: randomUUID(),
        scope,
        period,
        periodKey,
        tokensUsed: 0,
        callsUsed: 0,
        tokensLimit,
        callsLimit,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          budgetTracking.scope,
          budgetTracking.period,
          budgetTracking.periodKey,
        ],
        set: {
          tokensLimit,
          callsLimit,
          updatedAt: now,
        },
      })
      .run();
  }

  return {
    canSpend,
    spend,
    getRemainingBudget,
    resetPeriod,
    initBudget,
  };
}
