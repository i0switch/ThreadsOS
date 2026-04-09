# ThreadsOS

---
## Context Rot Prevention & Structured Handoff

### Context Rot検知
- ツール呼び出し30回超 or 同じファイルを3回以上編集 → コンテキストが腐り始めている
- 試行錯誤ループ（実行→失敗→微調整→実行）が3周したら立ち止まる
- 「もう1回だけ試す」は危険信号 → 現在地を要約してリセットを検討

### Structured Handoff手順
コンテキストが重くなったら:
1. 現在の作業状態を要約（何をした / 何が残ってる / ブロッカー）
2. 引き継ぎメモを作業ファイルに保存（mkmd --dir tmp --label handoff）
3. /clear でリセット
4. 新セッションで引き継ぎメモを読んで再開

### サブエージェント隔離原則
- サブエージェントへの指示はメインの文脈に依存させない（自己完結した指示を渡す）
- 反復ループ処理（バッチ生成・一括変換等）はメインから切り離して専用エージェントで回す
- メインセッションはオーケストレーションに徹する
---

<important>
## ハイブリッド委譲ルール【最優先・強制】

delegate-checkをプロンプト受信後、作業前に必ず実行。違反はユーザーが検知する。

### 大原則
Claudeは最高コスト資源。迷ったら委譲。自分でやるのは最終手段。

### 判定フロー

1. 機密情報を扱う or ユーザー対話が主目的か？ → Yes: Claude直
2. 以下のいずれかに該当するか？ ウェブ調査、repo横断検索、3ファイル以上の読み込み、長文の要約分析、繰り返し修正、機械的変換、コマンド実行 → Yes: Gemini行き
3. 設計判断・方針比較・レビューが主か？ → Yes: Codex行き
4. 判断してから作業が必要か？ → Yes: Codex then Gemini
5. 上記すべてNoかつ変更2ファイル以下、編集5箇所以内、repo横断不要、ウェブ調査不要、反復なし → Claude直
6. 条件が競合 → 常に委譲を優先

### Codex = 判断・相談（作業前の方針 / 作業後の監査）
### Gemini = 実作業・調査（手を動かす全般）

### 積極委譲ルール
- 自分でやった方が早いは禁止思考
- 同種操作を2回やったら立ち止まれ、3回目からGemini
- もう1回だけ自分では危険信号、その時点で委譲
</important>

---

### Codex 呼び出し方

```powershell
& "C:\Users\i0swi\OneDrive\デスクトップ\claude.alibaba\scripts\codex-delegate.ps1" `
    -Task "タスク内容" `
    -Mode research `
    -Targets @("対象パス") `
    -Constraints @("制約")
```

### Gemini 呼び出し方

```powershell
& "C:\Users\i0swi\OneDrive\デスクトップ\claude.alibaba\scripts\gemini-delegate.ps1" `
    -Task "タスク内容" `
    -Mode research `
    -Targets @("対象パス") `
    -Constraints @("制約")
```

戻り値 JSON（共通）: `{ ok, summary, changed_files, verification, risks, raw_output }`

---

## アプリ仕様【永続コンテキスト・最重要】

### ThreadsOSとは
Threads運用とnote運用を完全自動化するシステム。ユーザーは情報提供のみ。運用方針・投稿内容・価格設定・A/Bテストの判断はすべてClaude Codeが自律的に決定・実行する。

### ユーザーが行うこと（これだけ）
- 運用するテーマ・ジャンルを決めて共有する
- 参考資料や競合リサーチ結果を提供する
- Threadsのアカウント情報、noteのアカウント情報を設定する
- 投稿したnote記事にヘッダー画像を追加する

### Claude Codeが行うこと（すべて自動）

**ハートビート実行**
- ループ実行 / スケジュール実行 / デスクトップアプリのスケジュール機能による実行

**Threads運用（完全自動化）**
- 投稿の生成（テーマ・型・トーンすべて自律判断）
- エンゲージメントの調査
- 競合リサーチ
- リプライ返信
- 投稿頻度の調整（データに基づく自律判断）
- 投稿内容の調整（A/Bテスト結果に基づく自律判断）

**note運用（完全自動化）**
- 記事の生成
- エンゲージメントの調査
- 競合リサーチ
- 投稿頻度の調整
- 投稿内容の調整
- 価格設定の調整（データに基づく自律判断）

### 自律判断の原則
- ユーザーに「どうする？」と聞かない。データとリサーチに基づいて自分で決める
- 運用方針の変更（ターゲット切替、型の変更、価格変更等）もClaude Codeが判断する
- 判断に迷ったらリサーチデータ（human_inputs）とエンゲージメントデータを根拠にする
- 必要なスキル・プラグインはネット上から調査して導入するか、自ら生成・実装する

### 自動化範囲
| 作業 | 担当 |
|------|------|
| ジャンル選定 | **人間**（初回のみ） |
| 競合リサーチ追加 | **人間**（任意・不定期） |
| 運用方針の決定・変更 | **Claude Code 自律判断** |
| Threadsリサーチ〜投稿〜返信 | **Claude Code 完全自動** |
| note記事生成〜投稿〜価格設定 | **Claude Code 完全自動** |
| サムネイル追加 | **人間**（投稿後に手動） |

### note投稿
- **Playwright（ブラウザ自動操作）で本番自動投稿する**
- 非公式APIは使わない。ブラウザUIを操作する方式
- 実装は `C:\Users\i0swi\OneDrive\デスクトップ\記事自動生成` のPlaywrightベースのnote投稿機構を流用する
  - `apps/server/src/adapters/note-save-adapters.ts`
  - `apps/server/src/services/note-save-service.ts`
- 価格設定（有料記事）もClaude Codeが自動で行う
- `NOTE_MODE=browser_assisted` が運用上のデフォルト

### LLM
- ローカル運用時は `LLM_MODE=heartbeat`
- Claude Code 自身がLLMとして処理する（Anthropic API直接呼び出しは不要）
