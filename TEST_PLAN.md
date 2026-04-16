# ThreadsOS テスト計画

## テストカテゴリ

### Unit Tests (単体テスト)

個別サービス・ユーティリティの動作検証。DB はインメモリ SQLite を使用。

- `tests/config.test.ts` -- 環境変数のバリデーション・デフォルト値
- `tests/db.test.ts` -- DB 接続・テーブル作成
- `tests/budget.test.ts` -- 予算管理 (initBudget, canSpend, spend, resetPeriod)
- `tests/memory.test.ts` -- メモリサービス (レイヤー管理、有効期限)
- `tests/diff-collector.test.ts` -- 差分収集ロジック
- `tests/llm-json.test.ts` -- LLM 応答の JSON パース
- `tests/content-scheduler.test.ts` -- コンテンツスケジューラー (スロット管理、アクション決定)
- `tests/proposal-flow.test.ts` -- proposal 承認フローのステータス遷移

### Integration Tests (統合テスト)

複数サービスを組み合わせたフロー検証。

- `tests/executive.test.ts` -- ハートビートサイクル計画 (目的判定、アクション選定)
- `tests/department-execution.test.ts` -- 部署実行フロー
- `tests/services.test.ts` -- オーケストレーションサービス群
- `tests/note-services.test.ts` -- note 関連サービス
- `tests/jobs.test.ts` -- ジョブランナー
- `tests/reprocessing.test.ts` -- 再処理ロジック
- `tests/reexecution-safe.test.ts` -- 再実行安全性
- `tests/integration/heartbeat-flow.test.ts` -- ハートビート主要フロー
- `tests/integration/proposal-flow.test.ts` -- 提案・承認フロー
- `tests/integration/dashboard-e2e.test.ts` -- ダッシュボード API 統合

### E2E Tests (エンドツーエンドテスト)

- `tests/dashboard-api.test.ts` -- ダッシュボード全 API エンドポイント
- `tests/threads-api.test.ts` -- Threads API アダプター
- `tests/note-api.test.ts` -- note API アダプター
- `tests/llm-heartbeat-worker.test.ts` -- LLM ワーカー

## 重点テスト対象

### 仕様書の検証項目

1. **ハートビートサイクル完走**: 差分収集 → 戦略判断 → 部署実行 → サマリー更新
2. **system_controls による一時停止**: global pause 時にハートビートがスキップされる
3. **予算制御**: 予算超過時にアクションが持ち越される
4. **安全性チェック**: 5 回連続失敗で強制停止
5. **提案フロー**: 高リスクアクションが pending → 承認/却下 → executed/rejected
6. **自動承認**: ルーチンアクション (`generate_and_post` 等) は自動承認される
7. **ダッシュボード API**: 全エンドポイントが正しいレスポンスを返す
8. **DB 再実行安全性**: 同じジョブを 2 回実行しても整合性が崩れない
9. **コスト劣化モード**: emergency 時に低優先度アクションがスキップされる
10. **トークンリフレッシュ**: 7 日経過後に自動リフレッシュが試行される

## テスト実行方法

```bash
# 全テスト実行
pnpm test

# 特定テストファイル
pnpm test -- tests/integration/heartbeat-flow.test.ts

# ウォッチモード (開発中)
npx vitest watch
```

## カバレッジ目標

| カテゴリ | 目標 |
|----------|------|
| サービス層 (services/) | 80%+ |
| DB スキーマ・ブートストラップ | 90%+ |
| ダッシュボード API | 100% (全エンドポイント) |
| アダプター層 | 60%+ (外部依存はモック) |
| ジョブ | 70%+ (主要パス) |

## テスト環境

- `NODE_ENV=test`
- `DATABASE_URL=:memory:` (インメモリ SQLite)
- 外部 API はすべてモック (`vi.mock`)
- Playwright はモック (`DryRunNoteApiClient`)
- LLM はモック (`DryRunLlmClient`)
