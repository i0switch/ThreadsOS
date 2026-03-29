# ThreadsOS

Threads + Note 自動化パイプライン。トピックリサーチからスレッド投稿、エンゲージメント分析、ノート記事生成までを自動化する。

## セットアップ

```bash
# 依存関係のインストール
pnpm install

# 環境変数の設定
cp .env.example .env
# .env を編集して必要な値を設定

# データベースのマイグレーション
pnpm db:migrate
```

## コマンド一覧

### 開発

| コマンド | 説明 |
|---|---|
| `pnpm dev` | 開発サーバー起動（ホットリロード） |
| `pnpm build` | TypeScriptビルド |
| `pnpm test` | テスト実行 |
| `pnpm lint` | Biomeによるリント |
| `pnpm db:migrate` | DBマイグレーション実行 |

### ジョブ

| コマンド | 説明 |
|---|---|
| `pnpm job:daily-topic-research` | デイリートピックリサーチ |
| `pnpm job:daily-threads-plan` | デイリースレッド計画 |
| `pnpm job:nightly-note-pipeline` | ナイトリーノートパイプライン |

### レビュー

| コマンド | 説明 |
|---|---|
| `pnpm review:list` | レビュー待ちアイテム一覧 |
| `pnpm review:approve <id>` | アイテム承認 |
| `pnpm review:reject <id>` | アイテム却下 |

## アーキテクチャ

```
src/
  app/          - ロガー、エラー定義
  config/       - 環境変数設定
  db/           - Drizzle ORM + SQLiteスキーマ
  domain/       - Zodスキーマ + 型定義
    threads/    - スレッド投稿関連
    note/       - ノート記事関連
    analytics/  - 分析関連
    review/     - レビュー関連
  adapters/     - 外部APIクライアント
    threads-api/
    note-research/
    llm/
    storage/
  services/     - ビジネスロジック
    topic-selection/
    research/
    post-generation/
    post-audit/
    engagement-analysis/
    note-generation/
    note-audit/
    orchestration/
  jobs/         - バッチジョブ
  cli/          - CLIコマンド
  server/       - Fastify HTTPサーバー
tests/          - テスト
```

## 技術スタック

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict, ESM)
- **Package Manager**: pnpm
- **ORM**: Drizzle ORM
- **Database**: SQLite (better-sqlite3)
- **Validation**: Zod
- **Logging**: Pino
- **HTTP**: Fastify
- **Testing**: Vitest
- **Linting**: Biome
