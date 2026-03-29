# Architecture: Threads x note 自動運用OS

## Overview

Threads 運用から note 収益化を継続改善する半自律OS。
Threads 公式APIで投稿・分析を自動化し、note は調査・ドラフト生成・監査を自動化、公開は人間確認。

## System Layers

```
┌─────────────────────────────────────────────────────┐
│                    CLI / Server                      │
│              (Fastify HTTP + CLI commands)            │
├─────────────────────────────────────────────────────┤
│                     Jobs Layer                       │
│  daily-topic-research / daily-threads-plan /          │
│  post-publish-followup / nightly-note-pipeline /     │
│  weekly-retro                                        │
├─────────────────────────────────────────────────────┤
│                   Services Layer                     │
│  topic-selection / research / post-generation /       │
│  post-audit / engagement-analysis / note-generation / │
│  note-audit / orchestration                          │
├─────────────────────────────────────────────────────┤
│                   Domain Layer                       │
│  threads/ note/ analytics/ review/                   │
│  (entities, value objects, enums, zod schemas)        │
├─────────────────────────────────────────────────────┤
│                  Adapters Layer                       │
│  threads-api/ note-research/ llm/ storage/           │
│  (外部API・DB・LLMへの接続を閉じ込める)                │
├─────────────────────────────────────────────────────┤
│                   Infrastructure                     │
│  SQLite (drizzle ORM) / pino logger / config (zod)   │
└─────────────────────────────────────────────────────┘
```

## Directory Structure

```
.
├─ src/
│  ├─ app/                    # アプリ初期化、DI
│  ├─ config/                 # 環境変数スキーマ (zod)、設定ロード
│  ├─ db/                     # drizzle スキーマ、マイグレーション、接続
│  ├─ domain/                 # ドメインモデル (外部依存なし)
│  │  ├─ threads/             # Threads 関連エンティティ
│  │  ├─ note/                # note 関連エンティティ
│  │  ├─ analytics/           # 分析データモデル
│  │  └─ review/              # human review エンティティ
│  ├─ adapters/               # 外部システム接続
│  │  ├─ threads-api/         # Threads Graph API クライアント
│  │  ├─ note-research/       # note 公開ページ取得 (research_only)
│  │  ├─ llm/                 # LLM 呼び出し (Claude API等)
│  │  └─ storage/             # ファイル・DB 永続化
│  ├─ services/               # ユースケースの実装
│  │  ├─ topic-selection/     # ジャンル候補管理・優先度付け
│  │  ├─ research/            # 競合・市場トピック調査
│  │  ├─ post-generation/     # Threads 投稿案生成
│  │  ├─ post-audit/          # 投稿監査 (共通監査基準)
│  │  ├─ engagement-analysis/ # エンゲージメント解析・改善提案
│  │  ├─ note-generation/     # note ドラフト生成
│  │  ├─ note-audit/          # note 監査
│  │  └─ orchestration/       # ジョブ間の調整・パイプライン制御
│  ├─ jobs/                   # 定期実行ジョブ (各ジョブは冪等)
│  │  ├─ daily-topic-research.ts
│  │  ├─ daily-threads-plan.ts
│  │  ├─ post-publish-followup.ts
│  │  ├─ nightly-note-pipeline.ts
│  │  └─ weekly-retro.ts
│  ├─ cli/                    # CLI エントリーポイント
│  └─ server/                 # Fastify HTTP サーバー
├─ prompts/                   # LLM プロンプトテンプレート
│  ├─ threads/
│  ├─ note/
│  ├─ analytics/
│  └─ scheduled/              # Cloud scheduled tasks 用
├─ data/                      # 実行時データ (gitignore対象)
│  ├─ threads/
│  │  ├─ drafts/
│  │  └─ audits/
│  ├─ note/
│  │  ├─ drafts/
│  │  └─ audits/
│  └─ replies/
├─ docs/
│  ├─ architecture.md         # 本ファイル
│  ├─ progress.md             # フェーズ進捗
│  ├─ assumptions.md          # 仮定の記録
│  ├─ runbook.md              # 運用手順書
│  ├─ risk-register.md        # リスク管理
│  └─ operating-model.md      # 運用モデル
├─ .claude/                   # Claude Code 運用基盤
│  ├─ agents/                 # サブエージェント定義
│  ├─ skills/                 # スラッシュコマンド定義
│  ├─ scripts/                # hook スクリプト
│  └─ settings.json           # プロジェクト設定
├─ scripts/                   # ビルド・ユーティリティ
├─ tests/                     # テスト
└─ README.md

```

## Domain Entities

| Entity | 所属 | 説明 |
|---|---|---|
| Topic | threads | ジャンル・テーマ候補 |
| ResearchItem | threads | 競合・市場調査結果 |
| ThreadPostDraft | threads | Threads 投稿下書き |
| ThreadPostAudit | threads | 投稿監査結果 |
| ThreadPostResult | threads | 投稿後の結果データ |
| ThreadReply | threads | 受信した返信 |
| ReplyDecision | review | 返信への対応判定 (safe_auto_reply / human_review / ignore) |
| ImprovementInsight | analytics | 改善提案 |
| NoteIdea | note | note ネタ候補 |
| NoteDraft | note | note 下書き |
| NoteAudit | note | note 監査結果 |
| CompetitorSnapshot | analytics | 競合スナップショット |
| ScheduledJobRun | app | ジョブ実行記録 |
| HumanReviewItem | review | 人間レビュー待ちアイテム |

## Data Flow

```
[Topic Research] → [Post Generation] → [Post Audit] → [Publish Queue]
       ↓                                                      ↓
  [Research DB]                                    [Threads API 投稿]
                                                          ↓
                                              [Engagement Analysis]
                                                          ↓
                                              [Improvement Insights]
                                                          ↓
                                              [Note Generation] → [Note Audit] → [Human Review]
```

### Threads パイプライン
1. **Topic Selection**: ジャンル候補 → 優先度付け → 採用
2. **Research**: 市場・競合調査 → evidence 蓄積
3. **Post Generation**: テーマ → 投稿案5本生成
4. **Post Audit**: 9つの監査基準で pass / revise / reject
5. **Publish**: dry-run → audit log → API投稿
6. **Follow-up**: 返信取得 → 分類 → safe のみ自動返信
7. **Analysis**: エンゲージメント解析 → 改善提案

### note パイプライン
1. **Idea Generation**: Threads の勝ちテーマ → note ネタ候補
2. **Draft Generation**: アウトライン → 本文ドラフト
3. **Audit**: 監査 → publish readiness スコア
4. **Review Queue**: human_review → 手動公開

### note 3モード
| モード | 説明 | 自動化範囲 |
|---|---|---|
| research_only | 公開ページ取得・分析のみ | 取得系API |
| draft_assist | 下書き生成・監査 | LLM生成 + ファイル保存 |
| browser_assisted | ブラウザ自動操作 (将来) | 抽象化のみ用意 |

## Technology Stack

| レイヤー | 技術 |
|---|---|
| 言語 | TypeScript |
| ランタイム | Node.js 20+ |
| パッケージマネージャ | pnpm |
| HTTP サーバー | Fastify |
| ORM | drizzle |
| DB | SQLite |
| バリデーション | zod |
| ログ | pino |
| テスト | vitest |

## Key Design Decisions

### domain と adapters の分離
- `domain/` は外部依存なし。純粋な型定義・ビジネスルール
- `adapters/` は外部API・DB接続を閉じ込める
- `services/` は domain と adapters を組み合わせてユースケースを実装

### LLM 呼び出しの集約
- すべての LLM 呼び出しは `adapters/llm/` 経由
- プロンプトテンプレートは `prompts/` に分離
- モデル切り替え・フォールバックは adapter 内で完結

### 監査の共通化
- Threads と note で共通の監査基準を使用
- 9つの監査項目: 誇張, 具体性不足, フック弱い, CTA弱い, 炎上リスク, 根拠不足, note導線不自然, テーマ擦りすぎ, ブランド口調ズレ
- 監査結果は pass / revise / reject + severity

### 冪等性と安全性
- すべてのジョブは再実行可能
- すべての外部書き込みは audit log を残す
- 危険操作は human review 経由
- dry-run モードを全ジョブに実装

### Human Review フロー
```
[自動処理] → risk判定 → high? → [HumanReviewItem] → 人間承認 → [実行]
                          ↓ low
                    [自動実行 + audit log]
```

## API / CLI Commands

| コマンド | 説明 |
|---|---|
| `pnpm dev` | 開発サーバー起動 |
| `pnpm test` | テスト実行 |
| `pnpm lint` | lint 実行 |
| `pnpm db:migrate` | DBマイグレーション |
| `pnpm job:daily-topic-research` | トピック調査ジョブ |
| `pnpm job:daily-threads-plan` | Threads計画ジョブ |
| `pnpm job:nightly-note-pipeline` | note パイプラインジョブ |
| `pnpm review:list` | レビュー待ち一覧 |
| `pnpm review:approve` | レビュー承認 |
| `pnpm review:reject` | レビュー却下 |

## Security Boundaries

- `.env` / `secrets/` / `credentials` は Claude Code から読み取り禁止
- note の自動本番公開は禁止
- 返信自動送信は safe 判定のみ
- 本番 destructive operation は人間承認必須
- Threads API トークンは環境変数経由、コードにハードコードしない
