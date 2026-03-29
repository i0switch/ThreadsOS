# ThreadsOS 最終修正案 v2: 完全自律運用

作成日: 2026-03-29
ベース: `docs/修正案-完全自律化.md` + `docs/analysis/threadsos-expansion-plan-2026-03-29.md`
監査反映: Claude Opus 4.6 + Codex GPT-5.4-mini 合同監査 (2026-03-29)

---

## 概要

ThreadsOS を「人間が毎回指示する日次バッチ」から「1時間おきハートビートで自律運用するOS」に改修する。
人間の作業は以下のみ:
- 初回ジャンル選定
- note公開後のサムネイル設定
- 任意の追加リサーチ・フィードバック投入

---

## 監査で潰した問題

| ID | 問題 | 対処 |
|---|---|---|
| H1 | 2文書の設計分裂 | 本文書に統合。命名・テーブル・ジョブ名を統一 |
| H2 | idempotency欠如 | 全アクションに状態遷移を定義 |
| H3 | note API placeholder | Phase分離。Phase 1はThreadsのみ |
| H4 | A-1 followup衝突 | fetchAndStoreResults削除、分析のみに限定 |
| H5 | orchestration interface未定義 | interfaceにメソッド追加を明記 |
| H6 | Part A既修正済み | Part A削除 |
| H7 | User-Agent即ブロック | ブラウザUA + Playwright推奨 |
| M1 | env未配線 | env値をDI注入に変更 |
| M2 | スケジュール重複 | upsert + cleanup |
| M3 | storage null | ガード追加 |
| M4 | TZ依存 | JST明示 |
| M5 | Phase依存曖昧 | Phase間依存を明記 |

---

## 駆動モデル: ハートビート方式

```
1時間おきハートビート (src/jobs/hourly-heartbeat.ts)
  |
  +-- Scheduler: 「今何すべき？」を判断
  |     +-- 時間帯・曜日 (JST明示)
  |     +-- 直近投稿からの経過時間
  |     +-- 未処理の返信数
  |     +-- 未公開の note ドラフト数
  |     +-- 分析データの鮮度
  |     +-- human_inputs の未処理件数
  |     +-- 最適投稿スケジュール（学習結果）
  |
  +-- 決定したアクションを順次実行
  |
  +-- 2時間おきに進捗通知
```

---

## ファイル構成（統合版）

### 新規作成

| ファイル | 役割 |
|---|---|
| `src/jobs/hourly-heartbeat.ts` | 全処理の起点 (1時間おき) |
| `src/services/content-scheduler/index.ts` | 「今何すべき？」判断 + 投稿枠管理 |
| `src/services/auto-publisher/index.ts` | 自動投稿・公開・返信送信 |
| `src/services/cadence-optimizer/index.ts` | 投稿頻度・時間・テーマ配分の最適化 |
| `src/services/reply-execution/index.ts` | safe返信の自動送信 |
| `src/services/notification/index.ts` | 2時間おき進捗通知 |
| `src/services/note-engagement-analysis/index.ts` | note投稿後の成果分析 |
| `src/adapters/note-api/index.ts` | note非公式API (Phase 3) |
| `src/adapters/scraper/index.ts` | スクレイピング抽象化 |
| `src/adapters/notifier/index.ts` | 通知先抽象化 (webhook/Discord/LINE) |
| `src/cli/input.ts` | 人間入力の口 |

### 既存修正

| ファイル | 修正内容 |
|---|---|
| `src/services/orchestration/index.ts` | interface拡張: `processHumanInputs()`, `runNoteResearch()`, `runHourlyHeartbeat()` 追加。followupからfetchAndStoreResults削除 |
| `src/services/research/index.ts` | source拡張: `threads_api`, `threads_scrape`, `note_scrape`, `note_unofficial_api`, `manual_input` |
| `src/services/post-generation/index.ts` | 勝ち筋・失敗テーマ・推奨投稿時間を参照 |
| `src/services/post-audit/index.ts` | 時間帯適合性・重複テーマ率を評価に追加 |
| `src/services/engagement-analysis/index.ts` | 時間帯/曜日/テーマ/フック/CTA別集計を追加 |
| `src/services/note-generation/index.ts` | 競合調査結果の構成差分取り込み + thumbnail_tasks生成 |
| `src/services/note-audit/index.ts` | 公開タイミング・導線強度・Threads連携性を監査対象に追加 |
| `src/db/schema.ts` | 9テーブル追加 (下記) |
| `src/config/env.ts` | 環境変数追加 |
| `src/jobs/runner.ts` | heartbeat二重起動防止強化 |
| `package.json` | スクリプト追加 |

---

## DBスキーマ追加（9テーブル統合版）

### 1. `operator_profiles` — 初回ジャンル設定・運用ポリシー

```typescript
export const operatorProfiles = sqliteTable("operator_profiles", {
  id: text("id").primaryKey(),
  primaryNiche: text("primary_niche").notNull(),
  subNiches: text("sub_niches"),           // JSON array
  tone: text("tone"),
  forbiddenTopics: text("forbidden_topics"), // JSON array
  monetizationGoal: text("monetization_goal"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

### 2. `human_inputs` — 人間からの追加入力

```typescript
export const humanInputs = sqliteTable("human_inputs", {
  id: text("id").primaryKey(),
  inputType: text("input_type").notNull(),   // "research" | "feedback" | "directive"
  content: text("content").notNull(),
  processed: integer("processed").notNull().default(0),
  processedAt: text("processed_at"),         // ★ idempotency: 処理完了時刻
  createdAt: text("created_at").notNull(),
});
```

### 3. `content_slots` — 投稿予定管理

```typescript
export const contentSlots = sqliteTable("content_slots", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),         // "threads" | "note"
  scheduledAt: text("scheduled_at").notNull(),
  topicId: text("topic_id"),
  draftId: text("draft_id"),
  status: text("status").notNull().default("pending"), // pending | reserved | published | skipped
  priority: integer("priority").default(5),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  // ★ 重複防止: 同一チャネル・同一時刻にはpending1つだけ
  uniqueSlot: unique().on(table.channel, table.scheduledAt, table.status),
}));
```

### 4. `optimization_decisions` — 最適化の理由記録

```typescript
export const optimizationDecisions = sqliteTable("optimization_decisions", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  decisionType: text("decision_type").notNull(), // "frequency" | "timing" | "theme_weight"
  beforeValue: text("before_value").notNull(),
  afterValue: text("after_value").notNull(),
  reason: text("reason").notNull(),
  // ★ 変更幅上限チェック用
  changePercent: real("change_percent"),
  approvedBy: text("approved_by").default("auto"), // "auto" | "human"
  createdAt: text("created_at").notNull(),
});
```

### 5. `channel_performance_snapshots` — 成果集計スナップショット

```typescript
export const channelPerformanceSnapshots = sqliteTable("channel_performance_snapshots", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  periodType: text("period_type").notNull(),  // "hourly" | "daily" | "weekly"
  periodKey: text("period_key").notNull(),    // "2026-03-29T14" | "2026-03-29" | "2026-W13"
  metrics: text("metrics").notNull(),         // JSON: {impressions, likes, replies, ...}
  createdAt: text("created_at").notNull(),
});
```

### 6. `note_post_results` — note投稿結果

```typescript
export const notePostResults = sqliteTable("note_post_results", {
  id: text("id").primaryKey(),
  draftId: text("draft_id").notNull(),
  noteUrl: text("note_url"),
  views: integer("views").default(0),
  likes: integer("likes").default(0),
  commentsCount: integer("comments_count").default(0),
  publishedAt: text("published_at").notNull(),
  createdAt: text("created_at").notNull(),
});
```

### 7. `thumbnail_tasks` — サムネ対応タスク

```typescript
export const thumbnailTasks = sqliteTable("thumbnail_tasks", {
  id: text("id").primaryKey(),
  noteDraftId: text("note_draft_id").notNull(),
  status: text("status").notNull().default("pending"), // pending | completed
  instruction: text("instruction"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});
```

### 8. `heartbeat_states` — heartbeat実行制御

```typescript
export const heartbeatStates = sqliteTable("heartbeat_states", {
  jobName: text("job_name").primaryKey(),
  lastRunAt: text("last_run_at"),
  nextNotificationAt: text("next_notification_at"),
  consecutiveFailures: integer("consecutive_failures").default(0),
  // ★ 二重起動防止
  lockedBy: text("locked_by"),
  lockedAt: text("locked_at"),
});
```

### 9. `outbound_notifications` — 通知履歴

```typescript
export const outboundNotifications = sqliteTable("outbound_notifications", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),               // "progress" | "action_needed" | "alert"
  content: text("content").notNull(),
  channel: text("channel").notNull().default("file"), // "file" | "discord" | "line"
  sentAt: text("sent_at").notNull(),
  // ★ 配信確認
  deliveredAt: text("delivered_at"),
  error: text("error"),
});
```

---

## Idempotency設計（監査H2対応）

heartbeatが毎時走る前提で、全アクションが再実行しても安全になるよう状態遷移を定義する。

### 返信送信

```
reply_decisions.decision = "safe_auto_reply"
  AND reply_decisions.sent_at IS NULL        ← ★ sent_at カラム追加
  → 送信 → sent_at = now()
```

DB変更: `reply_decisions` に `sent_at TEXT` カラム追加。

### 投稿スケジュール

```
content_slots.status = "pending"
  AND content_slots.scheduled_at <= now()
  → 投稿実行 → status = "published", updated_at = now()
```

unique制約で同一チャネル・同一時刻のpendingは1つだけ。

### human_inputs処理

```
human_inputs.processed = 0
  → 処理 → processed = 1, processed_at = now()
```

### スケジュール生成

```
generateSchedule() の前に:
  DELETE FROM content_slots
  WHERE channel = ? AND status = "pending" AND scheduled_at > now()
→ 全クリアしてから再生成
```

### エンゲージメント取得

```
最終取得から1時間未満 → スキップ
channel_performance_snapshots.period_key で重複チェック
```

---

## hourly-heartbeat.ts 設計

```typescript
// src/jobs/hourly-heartbeat.ts

import { runJob } from "./runner.js";
import { ContentSchedulerServiceImpl } from "../services/content-scheduler/index.js";
import { OrchestrationServiceImpl } from "../services/orchestration/index.js";
import { AutoPublisherServiceImpl } from "../services/auto-publisher/index.js";
import { CadenceOptimizerServiceImpl } from "../services/cadence-optimizer/index.js";
import { ReplyExecutionServiceImpl } from "../services/reply-execution/index.js";
import { NotificationServiceImpl } from "../services/notification/index.js";
import { ClaudeLlmClient, DryRunLlmClient } from "../adapters/llm/index.js";
import { ThreadsGraphApiClient, DryRunThreadsApiClient } from "../adapters/threads-api/index.js";
import { FileSystemStorageClient } from "../adapters/storage/index.js";
import { db } from "../db/index.js";
import { heartbeatStates } from "../db/schema.js";
import { eq } from "drizzle-orm";

const dryRun = process.argv.includes("--dry-run");
const llm = dryRun ? new DryRunLlmClient() : new ClaudeLlmClient();
const threadsApi = dryRun ? new DryRunThreadsApiClient() : new ThreadsGraphApiClient();
const storage = new FileSystemStorageClient();

const scheduler = new ContentSchedulerServiceImpl();
const orchestration = new OrchestrationServiceImpl();
const autoPublisher = new AutoPublisherServiceImpl();
const optimizer = new CadenceOptimizerServiceImpl();
const replyExec = new ReplyExecutionServiceImpl();
const notification = new NotificationServiceImpl(storage);

await runJob({ name: "hourly-heartbeat", dryRun }, async ({ dryRun, logger }) => {
  // ★ 二重起動防止
  const lock = db.select().from(heartbeatStates)
    .where(eq(heartbeatStates.jobName, "hourly-heartbeat")).get();
  if (lock?.lockedBy && lock.lockedAt) {
    const lockAge = (Date.now() - new Date(lock.lockedAt).getTime()) / 60000;
    if (lockAge < 50) { // 50分以内のロックは有効
      logger.warn({ lockedBy: lock.lockedBy, lockAge }, "Heartbeat already running, skipping");
      return "Skipped: another heartbeat is running";
    }
  }

  // ロック取得
  const lockId = `hb-${Date.now()}`;
  db.update(heartbeatStates).set({
    lockedBy: lockId,
    lockedAt: new Date().toISOString(),
  }).where(eq(heartbeatStates.jobName, "hourly-heartbeat")).run();

  try {
    const actions = await scheduler.decideActions();
    logger.info({ actionCount: actions.length }, "Heartbeat: actions decided");

    const results: string[] = [];

    for (const action of actions) {
      logger.info({ action: action.type, reason: action.reason }, "Executing action");
      try {
        switch (action.type) {
          case "process_human_inputs":
            results.push(await orchestration.processHumanInputs(llm, storage));
            break;

          case "research_threads":
            results.push(await orchestration.runDailyTopicResearch(llm, storage, dryRun));
            break;

          case "research_note":
            results.push(await orchestration.runNoteResearch(llm, storage, dryRun));
            break;

          case "generate_and_post":
            results.push(await orchestration.runDailyThreadsPlan(llm, storage, dryRun));
            const published = await autoPublisher.publishApprovedThreadDrafts(threadsApi);
            results.push(`Auto-published ${published.length} threads posts`);
            break;

          case "fetch_engagement":
            // ★ H4対応: 分析のみ。結果保存はpublish時に済んでいる
            results.push(await orchestration.runPostPublishFollowup(threadsApi, llm, dryRun));
            break;

          case "reply_safe":
            const repliesSent = await replyExec.executeSafeReplies(threadsApi);
            results.push(`Sent ${repliesSent} safe replies`);
            break;

          case "generate_note":
            results.push(await orchestration.runNightlyNotePipeline(llm, storage, dryRun));
            // ★ Phase 3 で有効化: note自動公開
            // const noteResults = await autoPublisher.publishApprovedNoteDrafts();
            break;

          case "optimize_schedule":
            await optimizer.analyzeAndUpdate(llm);
            results.push("Schedule optimized");
            break;

          case "notify":
            const report = await notification.generateProgressReport();
            await notification.sendNotification({ type: "progress", report });
            results.push("Progress notification sent");
            break;
        }
      } catch (actionError) {
        logger.error({ action: action.type, error: actionError }, "Action failed, continuing");
        results.push(`FAILED: ${action.type} - ${actionError}`);
        // ★ 個別アクション失敗でも全体は止めない
      }
    }

    return results.join("\n");
  } finally {
    // ★ ロック解放
    db.update(heartbeatStates).set({
      lockedBy: null,
      lockedAt: null,
      lastRunAt: new Date().toISOString(),
    }).where(eq(heartbeatStates.jobName, "hourly-heartbeat")).run();
  }
});
```

---

## content-scheduler 設計（scheduler統合版）

```typescript
// src/services/content-scheduler/index.ts

export type ActionType =
  | "process_human_inputs"
  | "research_threads"
  | "research_note"
  | "generate_and_post"
  | "fetch_engagement"
  | "reply_safe"
  | "generate_note"
  | "optimize_schedule"
  | "notify";

export interface ScheduledAction {
  type: ActionType;
  priority: number;
  reason: string;
}

export interface ContentSchedulerService {
  decideActions(): Promise<ScheduledAction[]>;
  getNextThreadSlot(): Promise<ContentSlot | null>;
  getNextNoteSlot(): Promise<ContentSlot | null>;
  reserveSlot(slotId: string, draftId: string): Promise<void>;
  completeSlot(slotId: string): Promise<void>;
  skipSlot(slotId: string, reason: string): Promise<void>;
}
```

### decideActions() のJST対応

```typescript
// ★ M4対応: タイムゾーン明示
function getJstHour(): number {
  const now = new Date();
  // UTC+9
  const jstOffset = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const jstMinutes = (utcMinutes + jstOffset) % 1440;
  return Math.floor(jstMinutes / 60);
}
```

---

## reply-execution 設計（idempotent版）

```typescript
// src/services/reply-execution/index.ts

export class ReplyExecutionServiceImpl implements ReplyExecutionService {
  private readonly maxRepliesPerHour: number;

  constructor(maxRepliesPerHour?: number) {
    // ★ M1対応: env値をDI
    this.maxRepliesPerHour = maxRepliesPerHour ?? Number(process.env.MAX_REPLIES_PER_HOUR ?? 10);
  }

  async executeSafeReplies(api: ThreadsApiClient): Promise<number> {
    // ★ H2対応: sent_at IS NULL で未送信のみ取得
    const pending = db.select({
      decision: replyDecisions,
      reply: threadReplies,
    }).from(replyDecisions)
      .innerJoin(threadReplies, eq(replyDecisions.replyId, threadReplies.id))
      .where(and(
        eq(replyDecisions.decision, "safe_auto_reply"),
        isNull(replyDecisions.sentAt)  // ★ 送信済みは除外
      ))
      .limit(this.maxRepliesPerHour)
      .all();

    let sent = 0;
    for (const { decision, reply } of pending) {
      if (!decision.autoReplyBody) continue;

      // ★ 二重送信防止: 送信前にsentAtを先に埋める (楽観ロック)
      db.update(replyDecisions).set({
        sentAt: new Date().toISOString(),
      }).where(and(
        eq(replyDecisions.id, decision.id),
        isNull(replyDecisions.sentAt)
      )).run();

      try {
        await api.replyToPost(reply.threadsReplyId, decision.autoReplyBody);
        sent++;
      } catch (error) {
        // 送信失敗 → sentAtをnullに戻してリトライ可能にする
        db.update(replyDecisions).set({ sentAt: null })
          .where(eq(replyDecisions.id, decision.id)).run();
        logger.error({ replyId: reply.id, error }, "Failed to auto-reply");
      }
    }
    return sent;
  }
}
```

---

## scraper設計（User-Agent修正版）

```typescript
// src/adapters/scraper/index.ts

// ★ H7対応: 一般的なブラウザUA
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class ScraperClientImpl implements ScraperClient {
  private readonly rateLimitMs = 3000; // 3秒間隔

  private async fetchWithRetry(url: string, retries = 2): Promise<string> {
    for (let i = 0; i <= retries; i++) {
      await this.delay();
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "ja,en;q=0.9",
          },
        });
        if (!response.ok) {
          if (response.status === 429 && i < retries) {
            await this.delay(10000); // rate limit時は10秒待ち
            continue;
          }
          throw new Error(`HTTP ${response.status}`);
        }
        return await response.text();
      } catch (error) {
        if (i === retries) throw error;
        logger.warn({ url, attempt: i + 1, error }, "Scrape retry");
      }
    }
    throw new Error("Unreachable");
  }
}
```

---

## cadence-optimizer 設計（重複防止版）

```typescript
// src/services/cadence-optimizer/index.ts

export class CadenceOptimizerServiceImpl implements CadenceOptimizerService {

  async generateSchedule(channel: string, days: number): Promise<void> {
    // ★ M2対応: 既存pendingスロットをクリアしてから再生成
    db.delete(contentSlots)
      .where(and(
        eq(contentSlots.channel, channel),
        eq(contentSlots.status, "pending"),
        gte(contentSlots.scheduledAt, new Date().toISOString())
      )).run();

    const optimalTimes = await this.analyzeOptimalTimes(channel);
    const topSlots = optimalTimes.slice(0, 5);
    // ... INSERT new slots
  }

  async adjustFrequency(llm: LlmClient): Promise<FrequencyRecommendation> {
    // ★ L1対応: LLM応答をパース+バリデーション
    const raw = await llm.generate(prompt, { temperature: 0.3 });
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.recommendedPostsPerDay !== "number") {
        throw new Error("Invalid response format");
      }
      // ★ 変更幅上限チェック
      const current = await this.getCurrentFrequency();
      const changePercent = Math.abs(parsed.recommendedPostsPerDay - current) / current * 100;
      if (changePercent > 100) {
        logger.warn({ changePercent }, "Frequency change too large, capping");
        // 急激な変更はhuman reviewへ
        return { ...parsed, needsHumanReview: true };
      }
      return parsed;
    } catch {
      logger.error({ raw }, "Failed to parse LLM frequency recommendation");
      return null;
    }
  }
}
```

---

## notification 設計（storage安全版）

```typescript
// src/services/notification/index.ts

export class NotificationServiceImpl implements NotificationService {
  private storage: StorageClient | null;

  constructor(storage?: StorageClient) {
    // ★ M3対応: null許容
    this.storage = storage ?? null;
  }

  async sendNotification(payload: NotificationPayload): Promise<void> {
    // ... content生成 ...

    // DB記録
    db.insert(outboundNotifications).values({
      id, type: payload.type, content,
      channel: "file",
      sentAt: now.toISOString(),
    }).run();

    // ★ M3対応: storageがなければファイル保存スキップ
    if (this.storage) {
      const fileName = `docs/notifications/${now.toISOString().replace(/[:.]/g, "-")}.md`;
      await this.storage.saveFile(fileName, content);
    }

    // TODO Phase 4: Discord Webhook / LINE Notify
  }

  async generateProgressReport(): Promise<ProgressReport> {
    // ★ L2対応: note公開数・返信送信数も集計
    const todayNotes = db.select().from(notePostResults)
      .where(gte(notePostResults.createdAt, todayStart)).all();

    const todayReplies = db.select().from(replyDecisions)
      .where(and(
        eq(replyDecisions.decision, "safe_auto_reply"),
        isNotNull(replyDecisions.sentAt),
        gte(replyDecisions.sentAt, todayStart)
      )).all();

    return {
      // ...
      todayStats: {
        notesPublished: todayNotes.length,
        repliesSent: todayReplies.length,
        // ...
      },
    };
  }
}
```

---

## env追加（DI配線版）

```typescript
// src/config/env.ts に追加

NOTE_SESSION_COOKIE: z.string().optional(),
NOTIFICATION_DISCORD_WEBHOOK: z.string().url().optional(),
NOTIFICATION_LINE_TOKEN: z.string().optional(),
MAX_POSTS_PER_HOUR: z.coerce.number().min(1).max(10).default(3),
MAX_REPLIES_PER_HOUR: z.coerce.number().min(1).max(30).default(10),
SCRAPER_RATE_LIMIT_MS: z.coerce.number().default(3000),
// ★ TZ明示
TZ: z.string().default("Asia/Tokyo"),
```

---

## DB migration追加分

既存テーブルへのカラム追加:

```sql
-- reply_decisions に sent_at 追加
ALTER TABLE reply_decisions ADD COLUMN sent_at TEXT;
```

---

## package.json 追加スクリプト

```json
{
  "job:heartbeat": "tsx src/jobs/hourly-heartbeat.ts",
  "job:heartbeat:dry": "tsx src/jobs/hourly-heartbeat.ts --dry-run",
  "input:research": "tsx src/cli/input.ts research",
  "input:feedback": "tsx src/cli/input.ts feedback",
  "input:directive": "tsx src/cli/input.ts directive"
}
```

---

## 実装フェーズ（依存順序明記）

### Phase 1: heartbeat基盤 + Threads自動投稿
前提: なし
対象:
- `src/db/schema.ts` — 9テーブル追加 + reply_decisions.sent_at追加
- `src/jobs/hourly-heartbeat.ts`
- `src/services/content-scheduler/index.ts`
- `src/services/auto-publisher/index.ts`
- `src/services/orchestration/index.ts` — interface拡張
- `src/config/env.ts`
- `src/cli/input.ts`
- `package.json`

ゴール: Threadsの調査→生成→監査→自動投稿がheartbeatで回る

### Phase 2: Threads自走強化
前提: Phase 1完了
対象:
- `src/services/cadence-optimizer/index.ts`
- `src/services/reply-execution/index.ts`
- `src/services/engagement-analysis/index.ts` — 時間帯/テーマ別集計追加

ゴール: 投稿頻度・時間の自動最適化 + 安全な自動返信

### Phase 3: note自走
前提: Phase 1完了（Phase 2と並行可能）
対象:
- `src/adapters/note-api/index.ts` — 実API実装
- `src/adapters/scraper/index.ts`
- `src/services/note-engagement-analysis/index.ts`
- `src/services/note-generation/index.ts` — 競合調査反映

ゴール: note競合調査 → 生成 → 公開 → 分析 → サムネタスク化

### Phase 4: 通知・運用完成
前提: Phase 2 + Phase 3完了
対象:
- `src/services/notification/index.ts`
- `src/adapters/notifier/index.ts` — Discord/LINE対応
- `docs/runbook.md` — 運用手順

ゴール: 2時間通知完成 + 障害時fallback + 運用ドキュメント

---

## リスクと対策（統合版）

### note非公式API依存
- adapter に隔離
- fallback を scraper / browser-assisted に分ける
- heartbeat 失敗時も他処理は止めない

### スクレイピング失敗
- source ごとに freshness 管理
- stale data を明示して使う
- 取得失敗時は前回スナップショットを利用

### 自動改善の暴走
- 変更幅100%超はhuman reviewへ
- `optimization_decisions` に理由を記録
- 前回比較で急変検知

### 自動返信の炎上
- safe のみ自動返信
- 高リスクは review queue
- reply 実行ログを必ず残す（sent_at記録）

### heartbeat二重起動
- `heartbeat_states.locked_by` + `locked_at` でロック
- 50分以上のロックはstale扱いで奪取

---

## 人間がやること（最終版）

| タイミング | 作業 |
|---|---|
| 初回のみ | ジャンル選定 (`pnpm input:directive "恋愛×自己理解"`) |
| note 公開後 | note の編集画面でサムネ設定（通知が来る） |
| 任意 | 追加リサーチ (`pnpm input:research "..."`) |
| 任意 | フィードバック (`pnpm input:feedback "..."`) |
| 2時間おき | 進捗通知を確認（対応不要なら放置OK） |
