# ThreadsOS 運用手順書 (RUNBOOK)

## 日常運用

### ハートビート実行

ThreadsOS の中核はハートビートジョブ。1 時間ごとに差分収集 → 戦略判断 → 部署実行を行う。

補助 cadence として 15 分 tier では `metrics-sync` が実行され、note session guard と note / Threads の metrics snapshot を更新する。

#### 手動実行

```bash
# 本番実行
pnpm job:heartbeat

# ドライラン (API 呼び出し・投稿なし)
pnpm job:heartbeat:dry
```

#### PM2 デーモン

```bash
# 起動 (ecosystem.config.cjs の設定で自動リスタート)
pnpm start:daemon

# 停止
pnpm stop:daemon

# ログ確認
pnpm logs

# PM2 のステータス確認
pm2 status
```

#### cron 設定例

```cron
# 毎時 0 分にハートビート実行
0 * * * * cd /path/to/ThreadsOS && pnpm job:heartbeat >> logs/heartbeat.log 2>&1
```

### ダッシュボード確認

```bash
pnpm dev
# http://localhost:3000/dashboard
```

ダッシュボードで確認できること:
- **Current State**: operations mode と現在の bottleneck
- **Runtime Health**: runner / session / outbox の状態
- **Execution Ledger**: anomaly / decision evidence / rollback の履歴
- **Auditor**: pass / rewrite / skip / quarantine の集計
- **Contracts**: agents / playbooks / policies のコンパイル結果

### 個別ジョブの手動実行

通常はハートビートが自動で判断するが、個別に実行することも可能:

```bash
pnpm job:daily-topic-research    # トピックリサーチ
pnpm job:daily-threads-plan      # Threads 投稿計画
pnpm job:post-publish-followup   # エンゲージメント取得
pnpm job:metrics-sync            # metrics同期 + note session guard
pnpm job:nightly-note-pipeline   # note 記事パイプライン
pnpm job:weekly-retro            # 週次振り返り
```

### 人間入力の投入

```bash
# リサーチ情報 (競合情報・参考 URL 等)
pnpm input:research

# フィードバック (運用への感想・改善要望)
pnpm input:feedback

# ディレクティブ (運用方針変更の指示)
pnpm input:directive
```

---

## トラブルシューティング

### LLM タイムアウト

**症状**: ハートビートが長時間ハングする

**対応**:
1. `heartbeat_states` テーブルの `locked_by` / `locked_at` を確認
2. 50 分以上ロックされていれば次回ハートビートで自動解放される
3. 手動解放が必要な場合:
   ```bash
   # clear-lock.ts を実行
   npx tsx clear-lock.ts
   ```

### レート制限

**症状**: Threads API から 429 エラー

**対応**:
1. `.env` の `MAX_POSTS_PER_HOUR` / `MAX_REPLIES_PER_HOUR` を下げる
2. `SCRAPER_RATE_LIMIT_MS` を増やす (デフォルト 3000ms)
3. ダッシュボードからシステム一時停止し、時間を置いてから再開

### DB 接続エラー

**症状**: `SQLITE_CANTOPEN` や DB 関連エラー

**対応**:
1. `data/` ディレクトリが存在するか確認
2. DB ファイルのパーミッションを確認
3. `.env` の `DATABASE_URL` が正しいか確認
4. DB ファイルが壊れた場合はバックアップからリストア

### トークン期限切れ

**症状**: Threads API から 401 エラー

**対応**:
1. Threads のアクセストークンは 60 日で期限切れ
2. ハートビートが週 1 回自動リフレッシュを試みる
3. 手動リフレッシュ:
   ```bash
   pnpm job:refresh-token
   ```
4. リフレッシュも失敗する場合は Meta Developer Portal で新しいトークンを取得し `.env` を更新

### note.com セッション切れ

**症状**: note 投稿が失敗する

**対応**:
1. Playwright のストレージステートを再取得:
   ```bash
   pnpm note:login
   ```
2. `NOTE_PLAYWRIGHT_HEADLESS=false` にしてブラウザを表示しながらログイン確認

### ハートビート連続失敗

**症状**: 通知に「N 回連続失敗」が出る

**対応**:
1. 3 回連続: 警告通知が送信される
2. 5 回連続: 緊急通知 + 安全サービスが強制停止を検討
3. `pnpm logs` でエラー内容を確認
4. 原因を修正後、ハートビートを再実行

---

## バックアップ

### DB バックアップ

```bash
# SQLite DB ファイルをコピー
cp data/threads-note-os.db data/backup/threads-note-os-$(date +%Y%m%d).db
```

### note セッションバックアップ

```bash
cp data/note-storage-state.json data/backup/note-storage-state-$(date +%Y%m%d).json
```

### 自動バックアップ (cron)

```cron
# 毎日 3:00 にバックアップ
0 3 * * * cp /path/to/ThreadsOS/data/threads-note-os.db /path/to/backup/threads-note-os-$(date +\%Y\%m\%d).db
```

---

## 緊急停止

### ダッシュボードから

`/dashboard` の Control セクションで Pause ボタンを押す (scope: global)。

### API から

```bash
curl -X POST http://localhost:3000/api/dashboard/control/pause \
  -H "Content-Type: application/json" \
  -d '{"scope": "global"}'
```

### DB 直接操作

```sql
INSERT INTO system_controls (id, scope, action, reason, created_by, active, created_at)
VALUES (
  lower(hex(randomblob(16))),
  'global',
  'pause',
  'Emergency manual stop',
  'human',
  1,
  datetime('now')
);
```

### 再開

```bash
# ダッシュボード API
curl -X POST http://localhost:3000/api/dashboard/control/resume \
  -H "Content-Type: application/json" \
  -d '{"scope": "global"}'
```

### 部署単位の停止

`scope` を部署名 (`threads`, `note`, `community` 等) に変更すれば、特定部署のみ停止できる。

---

## 環境変数リファレンス

`.env.example` を参照。全環境変数の一覧と説明が記載されている。
