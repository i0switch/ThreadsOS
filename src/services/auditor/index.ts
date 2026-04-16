export type AuditorAction = "pass" | "rewrite" | "skip" | "quarantine";

export function normalizeAuditorAction(input: {
  verdict?: string | null;
  severity?: string | null;
  score?: number | null;
}): AuditorAction {
  if (input.verdict === "pass") {
    return "pass";
  }

  if (input.verdict === "revise") {
    return "rewrite";
  }

  if (input.verdict === "reject") {
    return "skip";
  }

  if (input.verdict) {
    return "quarantine";
  }

  if (input.severity === "high") {
    return "quarantine";
  }

  if (typeof input.score === "number") {
    if (input.score <= 2) {
      return "quarantine";
    }
    if (input.score < 7) {
      return "rewrite";
    }
  }

  return "rewrite";
}

export function normalizeLegacyReviewStatus(status: string): AuditorAction {
  if (status === "approved") {
    return "pass";
  }

  if (status === "rejected") {
    return "skip";
  }

  return "quarantine";
}

export function auditorActionLabel(action: AuditorAction): string {
  switch (action) {
    case "pass":
      return "pass";
    case "rewrite":
      return "rewrite";
    case "skip":
      return "skip";
    case "quarantine":
      return "quarantine";
  }
}
