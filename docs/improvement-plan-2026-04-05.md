# ThreadsOS 改善計画 — 完全自動運用仕様に合わせた全面再設計

**作成日**: 2026-04-05
**ステータス**: 改訂案

---

## 1. Context

ThreadsOS を回し始めた結果、理想の成果が得られていない。問題は個別機能の出来不出来ではなく、アーキテクチャの前提が仕様と一致していないことにある。

現状の ThreadsOS は、Threads と note の機能をそれぞれ自動化した「自動投稿ツール群」に近い。一方で仕様が求めているのは、管理・指揮系統を中心に複数部署が1時間ごとの heartbeat で連携し、Threads 集客から note 収益化までを継続改善する「完全自律運用OS」である。

最大の問題は次の3点である。

1. Threads が note 収益化のための集客導線として機能していない
2. 管理・指揮系統が存在せず、全体最適の戦略判断が行われていない
3. human review 前提が残っており、通常フローが完全自動運用になっていない

したがって、必要なのは小手先の改善ではなく、仕様に準拠した全面再設計である。

---

## 2. 現状 vs 仕様 ギャップ一覧

| # | 仕様の要求 | 現状 | 深刻度 |
|---|---|---|---|
| G1 | note起点でThreads集客戦略を組み立てる | Topics共有のみで、収益ファネルがない | 致命的 |
| G2 | 管理・指揮系統が全体を統括し、方針を決定する | ContentScheduler の action 列挙のみ | 致命的 |
| G3 | 各部署が情報連携しながら毎時PDCAを回す | orchestration の直列呼び出しに留まる | 高 |
| G4 | Threads と note が単一ファネルとして連携する | チャネルごとに独立したパイプライン | 高 |
| G5 | human review なしで通常運用が回る | high risk で人手承認が残る | 高 |
| G6 | 価格設定を実績ベースで自律調整する | 文字数ベースの固定価格 | 中 |
| G7 | 戦略判断をもとに投稿頻度、返信、改善を統括する | 時刻条件と局所ロジック中心 | 中 |
| G8 | 各部署が共通の知識と成果を共有する | 一部 snapshot はあるが共有文脈が薄い | 中 |

### 現状アーキテクチャの問題

```text
[topics] ──→ [Threads生成] ──→ [投稿] ──→ [分析]
   │
   └──→ [note生成] ──→ [公開] ──→ [分析]
```

この構造では、Threads と note が別々に最適化されるだけで、note 収益化のための集客導線が成立しない。

### 仕様が求める姿

```text
[管理・指揮系統 / Executive]
    │
    ├──→ [外部リサーチ部署]
    ├──→ [競合リサーチ分析部署]
    ├──→ [Threads運用部署]
    └──→ [note運用部署]
    │
    └── heartbeatごとに全体方針を決定

[note記事テーマ] ──→ [Threads集客投稿] ──→ [Threads反応] ──→ [note流入] ──→ [収益化]
      ↑                    │                      │                │
      └──── 改善指示 ──────┴──── 実績分析 ─────┴──── 価格調整 ─────┘
```

この構造では、各部署が独立して動くのではなく、管理・指揮系統が共通状況をもとに全体最適を判断する。

---

## 3. 再設計方針

今回の改善は、既存コードへの小規模増築ではなく、仕様完全準拠の全面再設計として進める。

方針は以下の通り。

1. 修正量の少なさよりも、完全自動運用の成立を優先する
2. Department 抽象と Executive を正式に導入する
3. heartbeat を単なる action 実行ではなく、組織サイクルに作り替える
4. Threads→note ファネルを追加機能ではなく、基幹アーキテクチャとして実装する
5. human review は通常フローから外し、例外時のみ残す
6. policy-based な意思決定へ移行する

---

## 4. 改善計画（6フェーズ）

### Phase 0: 完全自動運用の前提修復

**目的**: 完全自動運用を成立させるための土台を整える

#### 0-1. 計測ループの修復

**変更対象**:
- src/services/auto-publisher/index.ts
- src/services/engagement-analysis/index.ts
- src/services/note-engagement-analysis/index.ts
- src/adapters/note-api/index.ts

**対応内容**:
- Threads 投稿後の実測値取得を heartbeat の通常フローに接続する
- note 公開後の実績取得を実装し、空配列やゼロ固定に依存しないようにする
- note の価格、有料/無料区分、価格変更理由を保存できるようにする
- Executive が空データではなく、実測値をもとに判断できる状態にする

#### 0-2. 状態遷移の整理

**変更対象**:
- src/services/auto-publisher/index.ts
- src/services/post-audit/index.ts
- src/services/note-audit/index.ts
- src/cli/review-approve.ts
- src/db/schema.ts

**対応内容**:
- review 承認を前提とする状態遷移を縮退させる
- publish suppression と自動リライト再試行の条件を定義する
- 通常時の high risk は human review ではなく自動処理で吸収する

---

### Phase 1: 管理・指揮系統と部署モデルの正式導入

**目的**: 仕様書にある組織構成をコード構造に反映する

#### 1-1. Executive の導入

**新規対象**:
- src/services/executive/index.ts または同等の司令塔レイヤー

**責務**:
- 各部署の report を受け取る
- heartbeat ごとの全体方針を決める
- Threads 投稿方針、note テーマ、価格調整、返信方針、優先度変更を判断する

#### 1-2. Department 抽象の導入

**新規または再編対象**:
- src/domain/department/
- src/services/research/
- src/services/post-generation/
- src/services/note-generation/
- src/services/engagement-analysis/
- src/services/note-engagement-analysis/

**対象部署**:
- 外部リサーチ部署
- 競合リサーチ分析部署
- Threads運用部署
- note運用部署

**対応内容**:
- Department interface を定義する
- Department report と shared context を定義する
- 既存 service は部署内部ユースケースとして再配置する

---

### Phase 2: heartbeat を組織サイクルへ再設計

**目的**: 1時間ごとの heartbeat を、部署連携による完全自律サイクルへ変える

**変更対象**:
- src/jobs/hourly-heartbeat.ts
- src/services/orchestration/index.ts
- src/services/content-scheduler/index.ts

**新しい heartbeat フロー**:
1. 外部リサーチ部署の更新
2. 競合リサーチ分析部署の更新
3. Threads 運用部署の状況整理
4. note 運用部署の状況整理
5. Executive が全体方針を決定
6. Threads 実行
7. note 実行
8. 実績回収
9. 改善判断の保存
10. 次サイクル方針の反映

**ポイント**:
- 毎時の heartbeat が、単なる action 列挙ではなく、全体の意思決定ループになる
- 日次の strategic review に閉じず、heartbeat ごとに方針修正が入る

---

### Phase 3: Threads→note ファネルの基幹実装

**目的**: note 収益化のための Threads 集客を、システムの中心フローにする

#### 3-1. note 起点の Threads 投稿生成

**変更対象**:
- src/services/post-generation/index.ts
- src/services/orchestration/index.ts

**対応内容**:
- 公開済み note 記事、公開予定 note 記事、狙う収益テーマを Threads 生成へ渡す
- Threads 投稿を単体エンゲージメント目的ではなく、note への導線として設計する
- note テーマと Threads トピックの優先度を Executive 判断で連動させる

#### 3-2. note 公開後の再配信

**変更対象**:
- src/jobs/hourly-heartbeat.ts
- src/services/auto-publisher/index.ts

**対応内容**:
- note 公開直後に Threads 告知投稿を生成する
- その後の反応を note パフォーマンスと結びつけて分析する

#### 3-3. cross-channel insight の正式統合

**変更対象**:
- src/services/note-engagement-analysis/index.ts
- src/services/engagement-analysis/index.ts
- src/db/schema.ts

**対応内容**:
- Threads と note の相関分析を improvement insight と strategy decision に保存する
- 分析止まりではなく、次回の生成、価格、優先度へ接続する

---

### Phase 4: human review 廃止と policy-based 判断への移行

**目的**: 自律運用の阻害要因を除去し、全体判断をルールと戦略で制御する

#### 4-1. human review の例外機構化

**変更対象**:
- src/db/schema.ts
- src/services/post-audit/index.ts
- src/services/note-audit/index.ts
- src/cli/review-approve.ts

**対応内容**:
- 通常フローから human review を撤去する
- retry 上限超過、危険度閾値超過、外部要因不確実性などの条件でのみ退避する

#### 4-2. policy-based scheduler への置換

**変更対象**:
- src/services/content-scheduler/index.ts

**対応内容**:
- 時刻条件ベースの decideActions から移行する
- Executive 判断をもとに、未達 KPI、収益優先度、研究不足、返信負荷、競合変化を見て各部署へタスク配分する

---

### Phase 5: 価格設定と改善判断の完全自律化

**目的**: note の収益化を仕様通り自律調整できるようにする

**変更対象**:
- src/services/auto-publisher/index.ts
- src/services/note-engagement-analysis/index.ts
- src/db/schema.ts

**対応内容**:
- 固定価格ロジックを廃し、実績ベースの価格判断に移行する
- 価格、価格変更理由、実験群、結果を保存する
- note の価格調整を Executive と note 部署が共同で判断する
- Threads 反応と note 収益を一体で評価する

---

### Phase 6: テストとドキュメントの全面更新

**目的**: 新アーキテクチャをコードと運用文書の両方で固定する

**変更対象**:
- tests/jobs.test.ts
- tests/services.test.ts
- tests/note-services.test.ts
- docs/operating-model.md
- docs/architecture.md
- README.md
- docs/runbook.md

**対応内容**:
- department 単位のテストを追加する
- Executive 判断テストを追加する
- Threads→note ファネルの統合テストを追加する
- human review 例外経路テストを追加する
- 半自律前提、手動公開前提、将来対応扱いの記述を除去する

---

## 5. 実装順序と依存関係

```text
Phase 0   前提修復
  ↓
Phase 1   Executive / Department 導入
  ↓
Phase 2   heartbeat 組織サイクル化
  ↓
Phase 3   Threads→note ファネル基幹実装
  ↓
Phase 4   human review縮退 + policy-based scheduler
  ↓
Phase 5   価格最適化の完全自律化
  ↓
Phase 6   テスト・docs全面更新
```

### 実装原則

- フェーズ分割はするが、設計思想は最初から完全自律前提で固定する
- 既存 service の再利用は行うが、責務配置は抜本的に見直す
- 「まず小さく直す」は採らない
- 仕様との不整合を残したまま進めない

---

## 6. 変更ファイルまとめ

| ファイル | Phase | 変更内容 |
|---|---|---|
| src/jobs/hourly-heartbeat.ts | 2, 3, 4 | heartbeat を組織サイクルへ再設計 |
| src/services/orchestration/index.ts | 1, 2, 3 | Executive 経由の全体制御へ移行 |
| src/services/content-scheduler/index.ts | 2, 4 | action-based から policy-based へ置換 |
| src/services/post-generation/index.ts | 3 | note 導線を前提にした投稿生成 |
| src/services/engagement-analysis/index.ts | 0, 3, 5 | Threads 実績収集と改善判断の統合 |
| src/services/note-engagement-analysis/index.ts | 0, 3, 5 | note 実績収集、相関分析、価格改善 |
| src/services/auto-publisher/index.ts | 0, 3, 5 | 投稿、公開、価格、結果保存の再設計 |
| src/services/post-audit/index.ts | 0, 4 | human review 前提の縮退 |
| src/services/note-audit/index.ts | 0, 4 | human review 前提の縮退 |
| src/adapters/note-api/index.ts | 0 | note 実績取得の強化 |
| src/db/schema.ts | 0, 1, 3, 4, 5 | shared context, strategy decision, pricing 実験, review 縮退 |
| docs/operating-model.md | 6 | 完全自律前提へ更新 |
| docs/architecture.md | 6 | Department / Executive モデルへ更新 |
| docs/runbook.md | 6 | 完全自動運用前提へ更新 |
| README.md | 6 | プロダクト定義とセットアップ前提の更新 |

---

## 7. 検証方法

### Phase 0 完了後
1. Threads 投稿の実測値が取得・更新されること
2. note 公開後の実績が空やゼロ固定でなく保存されること
3. 価格情報が保存されること

### Phase 1-2 完了後
1. Executive が各部署 report を受け取り、strategy decision を返すこと
2. heartbeat が部署連携サイクルとして動くこと
3. 各部署が同一 shared context を参照していること

### Phase 3-5 完了後
1. note テーマ起点で Threads 集客投稿が生成されること
2. note 公開後に Threads 告知投稿が出ること
3. high risk が通常時に human review に流れないこと
4. price experiment と結果反映が動くこと
5. Threads→note→収益化の改善ループが heartbeat 単位で継続すること

### 最終確認
1. docs 全体で完全自動運用前提が統一されていること
2. heartbeat 1サイクルを dry-run で通し、全体判断から投稿、分析、改善までつながること
3. テストで Department、Executive、ファネル、価格調整、例外経路がカバーされていること

---

## 8. 結論

ThreadsOS を仕様通りの完全自動運用OSにするためには、既存コードへの小規模増築では不十分である。
必要なのは、管理・指揮系統、部署連携、policy-based 判断、Threads→note ファネル、human review 縮退、価格自律調整を含む全面再設計である。

修正量が増えても、仕様に合わない構造を温存するより、完全自動運用として成立する構造へ先に揃えるべきである。
