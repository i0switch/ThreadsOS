# ThreadsOS ダッシュボード再設計 修正案 v2

## 設計原則

ユーザーが見たいのは「AIが何をやったか」「成果はどうか」「自分がやることはあるか」。
管理コンソールではなく、**運用レポート**として設計する。

---

## 新しい画面構成

### レイアウト

1カラム。右パネル廃止。上から順に読むだけ。

---

### セクション1: ヘッダー（簡素化）

```
ThreadsOS
テーマ: 返信が遅い男の本心と対処法 | 最終更新: 10:02
```

- 長い説明文・チップ類・トグルボタンは全削除
- テーマ名と最終更新だけ

---

### セクション2: 成果サマリ

数字を大きく。一目で分かるKPIカード。

```
┌──────────────────────────────────────────────────────────┐
│  今週の成果                                               │
│                                                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │   50    │  │   495   │  │    0    │  │   ¥0   │     │
│  │  投稿   │  │  表示   │  │  note   │  │  売上   │     │
│  │ Threads │  │ 7日間   │  │  公開   │  │  累計   │     │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │
│                                                           │
│  Threads→note の流れ                                      │
│  投稿案15件 → 監査通過13件 → 1件公開 → note下書き1件     │
│  ⚠ noteの公開が止まっている                               │
└──────────────────────────────────────────────────────────┘
```

データソース:
- `/api/dashboard/summary` の `threads7d`, `notes7d`
- `/api/dashboard/home` の `revenueSummary`, `funnelPreview`

---

### セクション3: 最新のThreads投稿（10件）

実際に投稿された内容が見える。

```
┌──────────────────────────────────────────────────────────┐
│  Threads 最新投稿                                10件     │
│                                                           │
│  4/11 15:56  「彼って私のこと本気なの？」その疑問が      │
│              浮かんだ時点で、答えはもう半分出てる…        │
│              表示: 0  いいね: 0                           │
│                                                           │
│  4/11 00:03  【曖昧な関係 脈なし度チェック】             │
│              当てはまる数を数えて👇…                     │
│              表示: 0  いいね: 0                           │
│                                                           │
│  4/7  02:28  付き合う前、3日間返信が来なくて             │
│              「終わった」と思ってた…                      │
│              表示: 189  いいね: 1  ← ベスト               │
│  ...                                                      │
└──────────────────────────────────────────────────────────┘
```

データソース: 新規API `/api/dashboard/recent-posts`
- `thread_post_results` JOIN `thread_post_drafts` で本文取得
- published_at DESC LIMIT 10
- impressions, likes, replies_count を表示

---

### セクション4: note記事（下書き5件 + 公開済み5件）

```
┌──────────────────────────────────────────────────────────┐
│  note 記事                                                │
│                                                           │
│  公開済み: なし                                           │
│                                                           │
│  下書き:                                                  │
│  📝 返信が遅い、LINEが短い…その先にあるのは何か         │
│     ｜曖昧な関係を終わらせる判断基準                     │
│     ステータス: draft  作成: 4/11                         │
│                                                           │
│  📝 LINE返信が遅い男の本心は                             │
│     『興味がない』ではなく『○○』だった                   │
│     ステータス: draft  作成: 4/11                         │
│  ...                                                      │
│                                                           │
│  📷 ヘッダー画像待ち: なし                               │
└──────────────────────────────────────────────────────────┘
```

データソース: 新規API `/api/dashboard/recent-notes`
- `note_post_results` ORDER BY published_at DESC LIMIT 5（公開済み）
- `note_drafts` ORDER BY created_at DESC LIMIT 5（下書き）
- `thumbnail_tasks` WHERE status='pending'（画像待ち）

---

### セクション5: ハートビート履歴（直近10回）

各ハートビートでAIが何を判断し、誰が何をしたかが時系列で見える。

```
┌──────────────────────────────────────────────────────────┐
│  AIの活動履歴                              直近10回        │
│                                                           │
│  ── 4/12 00:54 ── objective: ファネル拡大                │
│  │                                                        │
│  │  （実行中 — 結果待ち）                                │
│                                                           │
│  ── 4/11 15:09 ── objective: ファネル拡大                │
│  │                                                        │
│  │  threads | generate_and_post | 完了                    │
│  │    → 15件生成、13件監査通過、1件公開                  │
│  │                                                        │
│  │  note | generate_note | 完了                           │
│  │    → 下書き1件生成、0件公開、スケジュール最適化      │
│  │                                                        │
│  ── 4/11 10:11 ── objective: ファネル拡大                │
│  │                                                        │
│  │  threads | generate_and_post | 完了                    │
│  │    → 0件生成 (dry-run)、1件公開                       │
│  │                                                        │
│  │  threads | fetch_engagement | 完了                     │
│  │    → 2件のフォローアップ処理                          │
│  │                                                        │
│  │  note | generate_note | 完了                           │
│  │    → (dry-run) テーマからnote下書き生成予定           │
│  ...                                                      │
└──────────────────────────────────────────────────────────┘
```

データソース: 新規API `/api/dashboard/heartbeat-history`
- `executive_cycles` ORDER BY created_at DESC LIMIT 10
- 各cycleに紐づく `department_runs` を cycle_id で JOIN
- department名はエージェント日本語名ではなくactionTypeベースで表示

---

### セクション6: エンゲージメント推移（折りたたみ）

```
┌──────────────────────────────────────────────────────────┐
│  ▶ エンゲージメント詳細                                   │
│                                                           │
│  Threads 7日間                                            │
│    投稿: 50件 | 表示: 495 | いいね: 1 | 返信: 0          │
│                                                           │
│  Threads 24時間                                           │
│    投稿: 1件 | 表示: 0 | いいね: 0 | 返信: 0             │
│                                                           │
│  note 7日間                                               │
│    公開: 0件 | 閲覧: 0 | いいね: 0 | 売上: ¥0            │
│                                                           │
│  ベスト投稿:                                              │
│    「付き合う前、3日間返信が来なくて…」 189表示 1いいね   │
└──────────────────────────────────────────────────────────┘
```

データソース: `/api/dashboard/summary` の `threads7d`, `threads24h`, `notes7d`, `notes24h`
ベスト投稿: `thread_post_results` ORDER BY impressions DESC LIMIT 1

---

## 削除するもの

| 現在 | 理由 |
|---|---|
| 「あなたの確認待ち」(inbox) | Executiveが自律処理。ユーザーに見せない |
| 「AIチームの流れ」(storyboard) | 内部情報 |
| 「AIの判断」(decisions) | 内部情報。ハートビート履歴で代替 |
| 「管理者の行動履歴」(timeline) | 内部情報。ハートビート履歴で代替 |
| 右側詳細パネル(aside) | 1カラム化で廃止 |
| 裏面データ（停止/再開/メモフォーム/KPI/ログ） | ユーザーの仕事じゃない |
| かんたん/くわしくトグル | 全部1画面 |

---

## 新規API（3本追加）

### GET `/api/dashboard/recent-posts`

```typescript
{
  posts: Array<{
    id: string;
    body: string;          // thread_post_drafts.body (最初の100文字)
    impressions: number;
    likes: number;
    repliesCount: number;
    publishedAt: string;
  }>;
  bestPost: { ... } | null;  // impressions最大の投稿
}
```

SQL:
```sql
SELECT tpr.id, tpd.body, tpr.impressions, tpr.likes, tpr.replies_count, tpr.published_at
FROM thread_post_results tpr
LEFT JOIN thread_post_drafts tpd ON tpr.draft_id = tpd.id
ORDER BY tpr.published_at DESC
LIMIT 10
```

### GET `/api/dashboard/recent-notes`

```typescript
{
  published: Array<{
    id: string;
    title: string;
    noteUrl: string | null;
    views: number;
    likes: number;
    revenueYen: number;
    publishedAt: string;
  }>;
  drafts: Array<{
    id: string;
    title: string;
    status: string;
    createdAt: string;
  }>;
  thumbnailTasks: Array<{
    id: string;
    noteTitle: string;    // JOIN: thumbnail_tasks.note_draft_id → note_drafts.title
    instruction: string;  // thumbnail_tasks.instruction（"note公開済み。サムネを設定して: {url}"）
    createdAt: string;
  }>;
}

// thumbnailTasks SQL:
// SELECT tt.id, nd.title AS noteTitle, tt.instruction, tt.created_at
// FROM thumbnail_tasks tt
// LEFT JOIN note_drafts nd ON tt.note_draft_id = nd.id
// WHERE tt.status = 'pending'
```

### GET `/api/dashboard/heartbeat-history`

```typescript
{
  cycles: Array<{
    id: string;
    objective: string;
    funnelStage: string;
    summary: string | null;
    createdAt: string;
    runs: Array<{
      department: string;
      actionType: string;
      status: string;
      summary: string;
    }>;
  }>;
}
```

SQL:
```sql
-- cycles
SELECT id, objective, funnel_stage, summary, created_at
FROM executive_cycles ORDER BY created_at DESC LIMIT 10

-- runs per cycle
SELECT department, phase AS actionType, status, summary
FROM department_runs WHERE cycle_id = ?
ORDER BY created_at
```

---

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `src/dashboard/public/index.html` | HTML + JS 全面書き換え |
| `src/dashboard/routes.ts` | 新規3エンドポイント追加 |
| `src/services/dashboard-query/index.ts` | 新規3クエリ関数追加 |

---

## 実装順序

1. `dashboard-query/index.ts` に3つの新規クエリ関数を追加
2. `routes.ts` に3つの新規APIエンドポイントを追加
3. `index.html` をゼロから書き直し（既存CSS活用）
4. ブラウザで表示確認

## 制約

- 既存のCSSクラス（glass, chip, font-space等）はそのまま活用
- Tailwind CDN + IBM Plex Sans JPフォントは継続
- htmx の script タグは削除してOK
- 既存のAPIルート（home, summary等）はそのまま残す（削除しない）
- 既存のJS関数（jfetch, esc, fd, fn等）はユーティリティとして再利用
