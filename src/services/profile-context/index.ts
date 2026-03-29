import { db } from "../../db/index.js";
import { operatorProfiles } from "../../db/schema.js";

export interface ProfileContext {
  primaryNiche: string;
  subNiches: string[];
  tone: string | null;
  forbiddenTopics: string[];
  monetizationGoal: string | null;
}

export interface ProfileContextService {
  getProfileContext(): ProfileContext | null;
  formatForPrompt(): string;
}

export class ProfileContextServiceImpl implements ProfileContextService {
  getProfileContext(): ProfileContext | null {
    const profile = db.select().from(operatorProfiles).limit(1).get();
    if (!profile) return null;

    return {
      primaryNiche: profile.primaryNiche,
      subNiches: profile.subNiches ? profile.subNiches.split(",").map((s) => s.trim()) : [],
      tone: profile.tone,
      forbiddenTopics: profile.forbiddenTopics ? profile.forbiddenTopics.split(",").map((s) => s.trim()) : [],
      monetizationGoal: profile.monetizationGoal,
    };
  }

  formatForPrompt(): string {
    const profile = this.getProfileContext();
    if (!profile) return "";

    const subNichesStr = profile.subNiches.length > 0 ? ` (${profile.subNiches.join(", ")})` : "";
    const toneStr = profile.tone ? `。トーン: ${profile.tone}` : "";
    const forbiddenStr = profile.forbiddenTopics.length > 0 ? `。禁止トピック: ${profile.forbiddenTopics.join(", ")}` : "";
    const goalStr = profile.monetizationGoal ? `。目標: ${profile.monetizationGoal}` : "";

    const formatted = `ジャンル: ${profile.primaryNiche}${subNichesStr}${toneStr}${forbiddenStr}${goalStr}`;
    return formatted.slice(0, 200);
  }
}
