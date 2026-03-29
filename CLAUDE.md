# ThreadsOS

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
