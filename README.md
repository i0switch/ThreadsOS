# ThreadsOS

Threads (Meta) と note.com の運用を完全自動化するシステム。
ユーザーはテーマ・資料を提供するだけ。投稿戦略・コンテンツ生成・エンゲージメント分析・価格設定まですべて Claude Code が自律的に判断・実行する。

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| ランタイム | Node.js (ESM) + TypeScript (strict) |
| パッケージ管理 | pnpm |
| DB | SQLite (better-sqlite3) + Drizzle ORM |
| バリデーション | Zod |
| API サーバー | Fastify |
| ログ | Pino |
| ブラウザ自動操作 | Playwright (note.com 投稿用) |
| LLM | Claude Code ハートビート方式 / Anthropic API 直呼び |
| リンター | Biome |
| テスト | Vitest |
| プロセス管理 | PM2 |

## セットアップ

```bash
# 1. クローン
git clone <repo-url> && cd ThreadsOS

# 2. 依存インストール
pnpm install

# 3. 環境変数を設定
cp .env.example .env
# .env を編集して THREADS_ACCESS_TOKEN, THREADS_USER_ID 等を記入
# LLM tier を変える場合は LLM_DEFAULT_TIER と tier別 model を調整

# 4. DB 初期化 & オペレータープロファイル設定
pnpm setup

# 5. ハートビート実行 (手動)
pnpm job:heartbeat

# ドライランで動作確認
pnpm job:heartbeat:dry
```

## 利用可能なコマンド

### サーバー・開発

| コマンド | 説明 |
|----------|------|
| `pnpm dev` | 開発サーバー起動 (hot-reload) + ダッシュボード |
| `pnpm build` | TypeScript ビルド |
| `pnpm test` | テスト実行 |
| `pnpm lint` | Biome リンター |
| `pnpm db:migrate` | DB マイグレーション |

### ジョブ

| コマンド | 説明 |
|----------|------|
| `pnpm job:heartbeat` | メインハートビート (全自動運用の中核) |
| `pnpm job:heartbeat:dry` | ドライラン (API 呼び出しなし) |
| `pnpm job:daily-topic-research` | デイリートピックリサーチ |
| `pnpm job:daily-threads-plan` | デイリー Threads 投稿計画 |
| `pnpm job:post-publish-followup` | 投稿後フォローアップ (エンゲージメント取得) |
| `pnpm job:metrics-sync` | metrics 同期 + note session guard |
| `pnpm job:nightly-note-pipeline` | ナイトリー note 記事パイプライン |
| `pnpm job:weekly-retro` | 週次振り返り |
| `pnpm job:llm-worker` | LLM タスクキューワーカー |
| `pnpm job:refresh-token` | Threads トークン手動リフレッシュ |
| `pnpm job:refresh-token:dry` | トークンリフレッシュ (ドライラン) |

15 分 tier 実行では `metrics-sync` が自動的に呼ばれ、note session guard と note / Threads の指標同期が継続実行される。

### CLI

| コマンド | 説明 |
|----------|------|
| `pnpm input:research` | リサーチ情報を投入 |
| `pnpm input:feedback` | フィードバックを投入 |
| `pnpm input:directive` | 運用指示を投入 |
| `pnpm setup` | 初期セットアップ (DB + プロファイル) |
| `pnpm note:login` | note.com セッション取得 (Playwright) |

### デーモン (PM2)

| コマンド | 説明 |
|----------|------|
| `pnpm start:daemon` | PM2 でハートビートをデーモン起動 |
| `pnpm stop:daemon` | デーモン停止 |
| `pnpm logs` | PM2 ログ表示 |

## ダッシュボード

```bash
pnpm dev
# ブラウザで http://127.0.0.1:3000/ を開く
```

ダッシュボードでは以下が確認できる:
- operations mode と現在の bottleneck
- runner / session / outbox の runtime health
- anomaly / decision evidence / rollback の execution ledger
- auditor の pass / rewrite / skip / quarantine 集計
- contract compiler の agents / playbooks / policies サマリー

本番運用では `.env` に `DASHBOARD_AUTH_TOKEN` を設定して、
`Authorization: Bearer <token>` または `x-dashboard-token: <token>` を付けてアクセスする。

## LLM tier

ThreadsOS の LLM 呼び出しは `fast` / `standard` / `premium` の 3 tier を持つ。

- `LLM_DEFAULT_TIER`: tier 指定がない通常生成の既定値
- `LLM_DIRECT_MODEL_*`: `LLM_MODE=direct` で使うモデル名
- `LLM_HEARTBEAT_MODEL_*`: `pnpm job:llm-worker` が Claude CLI に渡す model alias

標準では通常生成は `standard` を使い、監査系は `premium` を優先する。

## アーキテクチャ

```
src/
  adapters/          外部 API クライアント
    threads-api/       Threads Graph API
    note-api/          note.com Playwright 自動投稿
    note-research/     note.com リサーチ
    llm/               LLM クライアント (heartbeat / direct / dry-run)
    storage/           ファイルシステムストレージ
  app/               ロガー等の共通基盤
  cli/               CLI コマンド (setup, input, note-login)
  config/            環境変数ロード (Zod バリデーション)
  dashboard/         Fastify ルート + 静的 HTML
  db/                SQLite スキーマ, ブートストラップ, 接続
  domain/            ドメインモデル (threads, note, analytics, review)
  jobs/              スケジュールジョブ
  server/            Fastify サーバーエントリポイント
  services/          ビジネスロジック (下記「部署構成」参照)
```

## 部署構成

ThreadsOS は「仮想組織」として動作し、各部署がハートビートサイクル内で自律的に実行される。

| 部署 | 責務 | 主要サービス |
|------|------|-------------|
| command | 人間入力の処理・全体戦略 | executive, orchestration |
| research | トピック調査・競合分析 | research, topic-selection |
| threads | Threads 投稿生成・公開 | post-generation, post-audit, auto-publisher |
| note | note 記事生成・公開 | note-generation, note-audit |
| community | エンゲージメント分析・リプライ | engagement-analysis, reply-execution |
| optimization | 投稿頻度・価格最適化 | cadence-optimizer, content-scheduler |

### ハートビートサイクル

1. **差分収集** (diff-collector) -- 前回からの変化を検出
2. **重要度判定** -- 差分を優先度付け
3. **予算初期化** (budget) -- トークン/呼び出し制限
4. **安全性チェック** (safety) -- コスト劣化・強制停止判定
5. **実行計画** (executive) -- 目的・ファネルステージに基づくアクション選定
6. **部署実行** (department-execution) -- 承認済みアクションを順次実行
7. **結果統合** -- サマリー・KPI・メモリ更新
8. **通知** -- 異常時は Discord/ファイル通知

## ライセンス

Private / All rights reserved.
