# ThreadsOS セットアップガイド

## セットアップ手順

1. **依存関係のインストール**
   ```bash
   pnpm install
   ```

2. **環境変数の設定**
   ```bash
   cp .env.example .env
   # .env を開いて各キーを設定する
   ```

3. **DB初期化（初回のみ）**
   ```bash
   pnpm db:migrate
   ```

4. **トピックの追加**
   ```bash
   pnpm input:directive "AI×副業"
   ```

5. **ヘッドレス実行の設定**
   ```bash
   crontab -e
   ```

## crontab 設定例

hourly-heartbeat を毎時0分に実行する場合:

```cron
# ThreadsOS hourly heartbeat (毎時0分に実行)
0 * * * * cd /path/to/ThreadsOS && pnpm job:heartbeat >> logs/heartbeat.log 2>&1
```

`/path/to/ThreadsOS` は実際のプロジェクトパスに置き換えてください。

## dry-run モード

本番投稿せずに動作確認する場合:

```bash
pnpm job:heartbeat -- --dry-run
```

## ログ確認

```bash
tail -f logs/heartbeat.log
```
