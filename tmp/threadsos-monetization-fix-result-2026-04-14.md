# ThreadsOS マネタイズ修復 結果レポート (2026-04-14)

- 対象計画: `tmp/threadsos-monetization-fix-plan-v1-2026-04-14.md`
- 実装範囲: Fix-1a / 1b / 2 / 3 + note.com再ログイン
- 結果: **note記事 初公開達成 (690円)**

---

## 🏆 主要成果

### note記事が初めて自動公開された
- **URL**: https://note.com/mido_renai_note/n/nd7c0f098079a
- **タイトル**: 「本気の男」と「遊びの男」は、たった3つの行動で見分けられる
- **価格**: 690円 (自動価格決定)
- **HB結果**: `Auto-published 1 threads posts. Auto-published 1 notes`
- **クラッシュ**: なし (tsc OK / vitest 20/20 / HB正常完了)

### 副次効果
- `human_review_items pending`: 4件 → **0件**
- `note_drafts`: published ステータス +1
- `content_slots` (note): published +1、pending 7件残 (今後順次消化予定)

---

## 修正内容サマリ

| # | 修正 | 対象 | 効果 |
|---|---|---|---|
| Fix-3 | forbidden_topics 緩和 | operator_profiles DB | 「身体の関係」級の暗喩表現が pass 可能に |
| Fix-3 | 誤判定 human_review 4件クリア | human_review_items DB | 自動で消化した |
| Fix-1b | publishReadinessScore 閾値 6→5 | auto-publisher.ts:309, 583 (**2箇所**) | score=5 ドラフトも公開対象に |
| Fix-2 | audit fallback verdict human_review → revise | adapters/llm:207, 456 + note-audit:94, 107 | パース失敗時は自動リトライ、人間レビューに降らない |
| Fix-1a | catch強化 | auto-publisher:707-760 | 認証切れ検知 + outbound_notifications通知 + slot状態管理 |
| 付随 | note.com storageState再ログイン | data/note-storage-state.json | Playwright経由の自動公開が可能に |

---

## Codex監査反映 (重要)

Codex 実装後監査で**重大不整合発見**:
- Fix-1b で L310 (`>= 5`) だけ修正、L583 (`< 6`) がそのまま
- 結果: score=5 ドラフトが eligible 判定 → publish で弾かれる不整合
- 指摘直後に L583 も `< 5` に修正

この監査がなければ本番HBでも 0件公開のままだった可能性大。計画→実装→Codex監査→修正 のループが機能。

---

## 1000円ゴールまでの距離

- 設定価格: 690円 / 記事
- 必要販売: 1000 ÷ 690 = **2冊以上** (合計1,380円)
- または 次回以降の記事を 980円設定で 1冊でも可
- **現状の売上**: 0円 (公開直後なので当然)

---

## 残課題

| 優先度 | 課題 | 備考 |
|---|---|---|
| 🔴 高 | 宣伝導線 (Threads→note) | 57投稿ある Threads のエンゲージメント=0 が最大問題 |
| 🔴 高 | Threads計測 API 復旧 | 投稿は通るが likes/imp/replies が全部0 (API取得問題) |
| 🟡 中 | pending 7件 content slots の順次消化 | 1HBあたり1件消化の設計なので数日で完了 |
| 🟡 中 | P1-B (差分送信) 検討 | トークン削減レバーとして次の候補 |
| 🟢 低 | 認証切れ regex の強化 | Codex指摘、401等の追加文字列 |

---

## 変更ファイル (commit d19a89b)

```
37 files changed, 3411 insertions(+), 514 deletions(-)
```

新規:
- src/app/heartbeat-context.ts (循環依存解消)
- src/adapters/llm/token-logger.ts (P0-0計測基盤)
- src/jobs/heartbeat-loop.ts (常駐ループ)
- scripts/p1a-audit-poc.ts (P1-A POC用)
- src/services/dashboard-query/request-cache.ts
- tests/dashboard-query-cache.test.ts

主要修正:
- src/adapters/llm/index.ts (CLI json出力化 + 計測 + audit fallback revise)
- src/services/auto-publisher/index.ts (score閾値5 + catch強化)
- src/services/post-audit/index.ts (AUDIT_BATCH_SIZE + saveAuditResult共通化)
- src/services/note-audit/index.ts (fallback revise化)
- src/services/orchestration/index.ts (MAX=2 + settleThreadDraftsBatch 残置)
- src/services/engagement-analysis/index.ts (返信分類バッチ化)
- src/services/executive/index.ts (プロンプト要約化)
- src/services/post-generation/index.ts (label追加)

GitHub: https://github.com/i0switch/ThreadsOS/commit/d19a89b

---

## 次アクション案

1. **Threads計測 API 復旧調査** (エンゲージメント=0が拡散阻害の元凶、最優先)
2. **pending 7 content slots の消化確認** (今日以降のHBで自然に進むはず)
3. **販売結果の計測** (note.com 側のビュー・売上取得フロー確認)
4. (低優先) P1-B 差分送信調査

---

## まとめ

- **0円 → 公開1件 (690円設定)** まで到達
- 1000円達成には「売れること」が必要 → Threads導線強化が次の勝負所
- コード品質: tsc通過、テスト 20/20 pass、クラッシュなし
- ワークフロー「計画→Codex監査→実装→Codex監査」が重大不整合を捕捉し機能
